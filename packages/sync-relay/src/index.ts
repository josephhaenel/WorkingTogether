#!/usr/bin/env node
/**
 * WorkingTogether sync relay.
 *
 * A minimal, standard Yjs websocket relay: one Y.Doc per room (room = URL path,
 * e.g. ws://host:4200/<repo>). It implements the y-protocols sync + awareness
 * message protocol, so the official y-websocket `WebsocketProvider` (used by the
 * daemon) talks to it directly. The relay keeps each room's doc in memory and
 * fans every update out to the other connected peers.
 *
 * MVP scope: in-memory only (no on-disk persistence of the CRDT, no git baseline
 * / epoch landing — see docs/design/sync-loop.md for the production design).
 */

import { WebSocketServer, type WebSocket } from "ws";
import type { IncomingMessage } from "node:http";
import fs from "node:fs";
import path from "node:path";
import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as awarenessProtocol from "y-protocols/awareness";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";

const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;

interface Room {
  name: string;
  doc: Y.Doc;
  awareness: awarenessProtocol.Awareness;
  conns: Set<WebSocket>;
}

const rooms = new Map<string, Room>();

// Optional durability: persist each room's CRDT doc to disk so a relay restart
// doesn't lose live working-tree state. Opt-in via WT_RELAY_DATA_DIR.
const DATA_DIR = process.env.WT_RELAY_DATA_DIR;
const TOKEN = process.env.WT_RELAY_TOKEN || process.env.WT_TOKEN; // if set, ws ?token=... must match
const saveTimers = new Map<string, NodeJS.Timeout>();

function roomFile(name: string): string {
  const safe = name.replace(/[^a-zA-Z0-9_.-]/g, "_");
  return path.join(DATA_DIR as string, `${safe}.ydoc.bin`);
}

function scheduleRoomSave(room: Room): void {
  if (!DATA_DIR || saveTimers.has(room.name)) return;
  const t = setTimeout(() => {
    saveTimers.delete(room.name);
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      const file = roomFile(room.name);
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, Buffer.from(Y.encodeStateAsUpdate(room.doc)));
      fs.renameSync(tmp, file);
    } catch (e) {
      console.error(`[relay] save failed for room ${room.name}:`, e);
    }
  }, 400);
  t.unref?.();
  saveTimers.set(room.name, t);
}

function getRoom(name: string): Room {
  let room = rooms.get(name);
  if (room) return room;

  const doc = new Y.Doc();
  const awareness = new awarenessProtocol.Awareness(doc);
  const conns = new Set<WebSocket>();

  // Restore persisted state, if any, before wiring update handlers.
  if (DATA_DIR) {
    try {
      const buf = fs.readFileSync(roomFile(name));
      Y.applyUpdate(doc, new Uint8Array(buf));
    } catch {
      /* no prior state for this room */
    }
  }

  // Fan out document updates to every peer except the one that produced them.
  doc.on("update", (update: Uint8Array, origin: unknown) => {
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MESSAGE_SYNC);
    syncProtocol.writeUpdate(enc, update);
    const msg = encoding.toUint8Array(enc);
    for (const c of conns) if (c !== origin && c.readyState === c.OPEN) c.send(msg);
    const r = rooms.get(name);
    if (r) scheduleRoomSave(r);
  });

  // Fan out awareness (presence) updates to everyone.
  awareness.on(
    "update",
    ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }) => {
      const changed = added.concat(updated, removed);
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MESSAGE_AWARENESS);
      encoding.writeVarUint8Array(enc, awarenessProtocol.encodeAwarenessUpdate(awareness, changed));
      const msg = encoding.toUint8Array(enc);
      for (const c of conns) if (c.readyState === c.OPEN) c.send(msg);
    }
  );

  room = { name, doc, awareness, conns };
  rooms.set(name, room);
  return room;
}

function handleMessage(conn: WebSocket, room: Room, data: Uint8Array): void {
  const decoder = decoding.createDecoder(data);
  const encoder = encoding.createEncoder();
  const messageType = decoding.readVarUint(decoder);
  switch (messageType) {
    case MESSAGE_SYNC: {
      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      // Applies incoming sync (with `conn` as origin so we don't echo it back),
      // and writes any reply (e.g. syncStep2) into `encoder`.
      syncProtocol.readSyncMessage(decoder, encoder, room.doc, conn);
      if (encoding.length(encoder) > 1) conn.send(encoding.toUint8Array(encoder));
      break;
    }
    case MESSAGE_AWARENESS: {
      awarenessProtocol.applyAwarenessUpdate(room.awareness, decoding.readVarUint8Array(decoder), conn);
      break;
    }
    default:
      break;
  }
}

export function startRelay(port: number): WebSocketServer {
  const wss = new WebSocketServer({ port });

  wss.on("connection", (conn: WebSocket, req: IncomingMessage) => {
    conn.binaryType = "arraybuffer";
    const [rawPath, query] = (req.url || "/").slice(1).split("?");
    if (TOKEN) {
      const token = new URLSearchParams(query || "").get("token");
      if (token !== TOKEN) {
        conn.close(1008, "unauthorized");
        return;
      }
    }
    const roomName = decodeURIComponent(rawPath) || "default";
    const room = getRoom(roomName);
    room.conns.add(conn);

    conn.on("message", (data: ArrayBuffer) => {
      try {
        handleMessage(conn, room, new Uint8Array(data));
      } catch (e) {
        console.error(`[relay] message error in room ${roomName}:`, e);
      }
    });

    conn.on("close", () => {
      room.conns.delete(conn);
      // Stale awareness entries clear via the clients' outdated-timeout.
    });

    // Kick off the sync handshake: send our state vector (sync step 1).
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MESSAGE_SYNC);
    syncProtocol.writeSyncStep1(enc, room.doc);
    conn.send(encoding.toUint8Array(enc));

    // Send current awareness state, if any.
    const states = room.awareness.getStates();
    if (states.size > 0) {
      const aenc = encoding.createEncoder();
      encoding.writeVarUint(aenc, MESSAGE_AWARENESS);
      encoding.writeVarUint8Array(
        aenc,
        awarenessProtocol.encodeAwarenessUpdate(room.awareness, Array.from(states.keys()))
      );
      conn.send(encoding.toUint8Array(aenc));
    }
  });

  console.error(
    `wt-sync-relay listening on ws://localhost:${port}  (room = URL path, e.g. ws://localhost:${port}/<repo>)`
  );
  return wss;
}

// Run when invoked directly.
const PORT = parseInt(process.env.PORT || "4200", 10);
startRelay(PORT);
