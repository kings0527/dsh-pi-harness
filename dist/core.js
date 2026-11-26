// DSH_ROOT_RESOLVER_PATCH v1
import { knowledgeRoot as dshKnowledgeRoot } from '../lib/knowledge.js';
// core/runtime/root.ts
import { AsyncLocalStorage } from "node:async_hooks";
var scope = new AsyncLocalStorage;
function scopedProjectRoot() {
  return scope.getStore();
}
function runWithProjectRoot(root, operation) {
  return scope.run(root, operation);
}
// core/board/index.ts
import {
  appendFileSync as appendFileSync2,
  closeSync,
  existsSync as existsSync3,
  fsyncSync,
  linkSync,
  openSync,
  readFileSync as readFileSync2,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { join as join4 } from "node:path";

// core/storage/index.ts
import { mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
var storageRoot = null;
function getStorageRoot() {
  const scoped = scopedProjectRoot();
  if (scoped) {
    const root = join(scoped, ".pi-board");
    ensureDir(root);
    ensureDir(join(root, "topics"));
    ensureDir(join(root, "topics", "archive"));
    return root;
  }
  if (storageRoot)
    return storageRoot;
  storageRoot = join(process.cwd(), ".pi-board");
  ensureDir(storageRoot);
  ensureDir(join(storageRoot, "topics"));
  ensureDir(join(storageRoot, "topics", "archive"));
  return storageRoot;
}
function ensureDir(dir) {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

// core/events/index.ts
import { appendFileSync, mkdirSync as mkdirSync2 } from "node:fs";
import { dirname, join as join2 } from "node:path";
function appendEvent(type, details, root) {
  const event = {
    type,
    timestamp: Date.now(),
    details
  };
  const eventsPath = root ? join2(root, ".pi-board", "events.jsonl") : join2(getStorageRoot(), "events.jsonl");
  if (root)
    mkdirSync2(dirname(eventsPath), { recursive: true });
  appendFileSync(eventsPath, JSON.stringify(event) + `
`, "utf-8");
}

// core/board/integrity.ts
import { existsSync as existsSync2, readFileSync } from "node:fs";
import { join as join3 } from "node:path";
function assertTopicId(topicId) {
  if (typeof topicId !== "string" || topicId.length === 0 || /[\\/\0]/.test(topicId)) {
    throw new Error("Topic ID must be one non-empty path segment");
  }
}
function archivedTopicPaths(topicId) {
  assertTopicId(topicId);
  const archiveDir = join3(getStorageRoot(), "topics", "archive");
  return {
    jsonl: join3(archiveDir, `${topicId}.jsonl`),
    summary: join3(archiveDir, `${topicId}.summary.md`)
  };
}
function isValidTimestamp(value) {
  return typeof value === "number" && Number.isFinite(value) && !Number.isNaN(new Date(value).getTime());
}
function validateTopicShape(topic) {
  if (typeof topic !== "object" || topic === null)
    return "META is not an object";
  const t = topic;
  if (typeof t.id !== "string" || t.id.length === 0)
    return "META id is not a non-empty string";
  if (typeof t.goal !== "string")
    return "META goal is not a string";
  if (t.status !== "open" && t.status !== "closed")
    return "META status is not open/closed";
  if (!isValidTimestamp(t.createdAt))
    return "META createdAt is not a valid date";
  if (t.closedAt !== undefined && !isValidTimestamp(t.closedAt))
    return "META closedAt is not a valid date";
  if (t.integrityVersion !== undefined && t.integrityVersion !== 1) {
    return "META integrityVersion is not 1";
  }
  if (t.finalSeq !== undefined && (typeof t.finalSeq !== "number" || !Number.isInteger(t.finalSeq))) {
    return "META finalSeq is not an integer";
  }
  return null;
}
function validateNoteShape(note) {
  if (typeof note !== "object" || note === null)
    return "not an object";
  const n = note;
  if (typeof n.seq !== "number" || !Number.isInteger(n.seq))
    return "seq is not an integer";
  if (typeof n.author !== "string" || n.author.length === 0)
    return "author is not a non-empty string";
  if (!isValidTimestamp(n.timestamp))
    return "timestamp is not a valid date";
  if (typeof n.content !== "string")
    return "content is not a string";
  if (n.tags !== undefined && (!Array.isArray(n.tags) || n.tags.some((t) => typeof t !== "string"))) {
    return "tags is not a string array";
  }
  if (n.priority !== undefined && n.priority !== "critical")
    return 'priority is not "critical"';
  return null;
}
function validateNoteSeq(notes) {
  const issues = [];
  for (let i = 0;i < notes.length; i += 1) {
    const expected = i + 1;
    const seq = notes[i]?.seq;
    if (typeof seq !== "number" || !Number.isInteger(seq) || seq !== expected) {
      issues.push(`seq discontinuity: expected #${expected}, got ${String(seq)}`);
      break;
    }
  }
  return issues;
}
function totalNotesInSummary(summary) {
  const firstLine = summary.split(`
`, 1)[0]?.trim();
  const match = firstLine?.match(/^<!--\s*PI_BOARD_SUMMARY\s+v1\s+totalNotes=(\d+)\s*-->\s*$/);
  if (!match)
    return null;
  const n = Number(match[1]);
  return Number.isInteger(n) && n >= 0 ? n : null;
}
function legacyTotalNotes(summary, topic) {
  const headerBlock = `# Summary: ${topic.id}

**Goal**: ${topic.goal}
**Duration**:`;
  const blockStart = summary.indexOf(headerBlock);
  if (blockStart < 0)
    return null;
  const afterBlock = summary.slice(blockStart + headerBlock.length);
  const match = afterBlock.match(/^[^\n]*\n\*\*Total Notes\*\*:\s*(\d+)\s*\n\*\*Participants\*\*:/);
  if (!match)
    return null;
  const n = Number(match[1]);
  return Number.isInteger(n) && n >= 0 ? n : null;
}
function auditArchivedTopic(topicId) {
  const { jsonl, summary } = archivedTopicPaths(topicId);
  if (!existsSync2(jsonl))
    throw new Error(`Archived topic "${topicId}" not found`);
  const lines = readFileSync(jsonl, "utf-8").split(`
`).filter((line) => line.trim());
  const issues = [];
  let topic = null;
  if (!lines[0]?.startsWith("#META#")) {
    issues.push("missing META line");
  } else {
    try {
      const parsed = JSON.parse(lines[0].slice(6));
      const shapeIssue = validateTopicShape(parsed);
      if (shapeIssue) {
        issues.push(`META shape invalid: ${shapeIssue}`);
      } else {
        topic = parsed;
        if (topic.id !== topicId || topic.status !== "closed") {
          issues.push(`META identity/status mismatch (${topic.id}/${topic.status})`);
        }
      }
    } catch {
      issues.push("META line is not valid JSON");
    }
  }
  const notes = [];
  for (let i = 1;i < lines.length; i += 1) {
    try {
      const parsed = JSON.parse(lines[i]);
      const shapeIssue = validateNoteShape(parsed);
      if (shapeIssue) {
        issues.push(`line ${i + 1} shape invalid: ${shapeIssue}`);
        continue;
      }
      notes.push(parsed);
    } catch {
      issues.push(`line ${i + 1} is not valid JSON`);
    }
  }
  issues.push(...validateNoteSeq(notes));
  const maxSeq = notes.reduce((max, note) => typeof note?.seq === "number" && note.seq > max ? note.seq : max, 0);
  let witnessKind = "unverified";
  if (topic?.integrityVersion === 1) {
    witnessKind = "v1";
    if (typeof topic.finalSeq !== "number") {
      issues.push("v1 archive: META finalSeq missing");
    } else if (topic.finalSeq !== maxSeq) {
      issues.push(`v1 archive: finalSeq=${topic.finalSeq} vs JSONL maxSeq=#${maxSeq} mismatch`);
    }
    if (!existsSync2(summary)) {
      issues.push("v1 archive is missing summary.md");
    } else {
      const witness = totalNotesInSummary(readFileSync(summary, "utf-8"));
      if (witness === null) {
        issues.push("v1 archive: summary witness line missing or malformed");
      } else if (witness !== topic.finalSeq || witness !== maxSeq) {
        issues.push(`v1 archive: witness=${witness} disagrees (finalSeq=${topic.finalSeq}, JSONL maxSeq=#${maxSeq})`);
      }
    }
  } else if (topic && existsSync2(summary)) {
    const legacy = legacyTotalNotes(readFileSync(summary, "utf-8"), topic);
    if (legacy !== null) {
      witnessKind = "legacy-structured";
      if (legacy > maxSeq) {
        issues.push(`summary Total Notes=${legacy} but JSONL max seq=#${maxSeq}: tail notes lost (Git conflict rollback?)`);
      } else if (legacy < maxSeq) {
        issues.push(`summary Total Notes=${legacy} lags JSONL max seq=#${maxSeq}: summary rewritten/rolled back?`);
      }
    }
  }
  return { topicId, maxSeq, issues, witnessKind };
}
function assertArchivedTopicIntact(topicId) {
  const report = auditArchivedTopic(topicId);
  if (report.issues.length > 0) {
    throw new Error(`Archived topic "${topicId}" is corrupted: ${report.issues.join("; ")}`);
  }
  return report;
}

// core/board/index.ts
function topicsDir() {
  return join4(getStorageRoot(), "topics");
}
function assertTopicId2(topicId) {
  if (typeof topicId !== "string" || topicId.length === 0 || /[\\/\0]/.test(topicId)) {
    throw new Error("Topic ID must be one non-empty path segment");
  }
}
function topicJsonlPath(topicId) {
  assertTopicId2(topicId);
  return join4(topicsDir(), `${topicId}.jsonl`);
}
function topicBoardMdPath(topicId) {
  assertTopicId2(topicId);
  return join4(topicsDir(), `${topicId}.board.md`);
}
function archivedTopicJsonlPath(topicId) {
  assertTopicId2(topicId);
  return join4(topicsDir(), "archive", `${topicId}.jsonl`);
}
function lockPath(topicId) {
  return `${topicJsonlPath(topicId)}.lock`;
}
function journalPath(topicId) {
  return join4(topicsDir(), ".transactions", `${topicId}.close.json`);
}
function hasArchivedTopic(topicId) {
  return existsSync3(archivedTopicJsonlPath(topicId));
}
var lockWait = new Int32Array(new SharedArrayBuffer(4));
function processStartIdentity(pid) {
  try {
    const fields = readFileSync2(`/proc/${pid}/stat`, "utf-8").trim().split(" ");
    return fields[21] ? `linux-start:${fields[21]}` : null;
  } catch {
    return null;
  }
}
function parseLockRecord(raw) {
  try {
    const parsed = JSON.parse(raw);
    if (parsed?.version === 1 && Number.isInteger(parsed.pid) && typeof parsed.token === "string")
      return parsed;
  } catch {}
  const pid = Number(raw.trim());
  return Number.isInteger(pid) && pid > 0 ? { version: 1, pid, processStart: null, token: `legacy:${raw.trim()}`, acquiredAt: 0 } : null;
}
function readLock(topicId) {
  try {
    return parseLockRecord(readFileSync2(lockPath(topicId), "utf-8"));
  } catch {
    return null;
  }
}
function ownerIsProvablyDead(lock) {
  try {
    process.kill(lock.pid, 0);
  } catch (error) {
    return error?.code === "ESRCH";
  }
  if (lock.processStart?.startsWith("linux-start:")) {
    const current = processStartIdentity(lock.pid);
    return current !== null && current !== lock.processStart;
  }
  return false;
}
function reclaimProvablyDeadLock(topicId) {
  const path = lockPath(topicId);
  const observed = readLock(topicId);
  if (!observed || !ownerIsProvablyDead(observed))
    return false;
  const claim = `${path}.reclaim.${process.pid}.${randomUUID()}`;
  try {
    linkSync(path, claim);
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "EEXIST")
      return false;
    throw error;
  }
  try {
    const claimed = parseLockRecord(readFileSync2(claim, "utf-8"));
    const stillObserved = claimed?.version === 1 && claimed.token === observed.token && ownerIsProvablyDead(claimed);
    const current = readLock(topicId);
    if (!stillObserved || current?.token !== observed.token)
      return false;
    try {
      unlinkSync(path);
      return true;
    } catch (error) {
      if (error?.code === "ENOENT")
        return false;
      throw error;
    }
  } finally {
    try {
      unlinkSync(claim);
    } catch (error) {
      if (error?.code !== "ENOENT")
        throw error;
    }
  }
}
function acquireLock(topicId, timeoutMs = 5000) {
  const path = lockPath(topicId);
  const start = Date.now();
  while (true) {
    const record = {
      version: 1,
      pid: process.pid,
      processStart: processStartIdentity(process.pid),
      token: randomUUID(),
      acquiredAt: Date.now()
    };
    const candidate = `${path}.candidate.${process.pid}.${record.token}`;
    try {
      writeFileSync(candidate, JSON.stringify(record), { encoding: "utf-8", flag: "wx", mode: 384 });
      try {
        linkSync(candidate, path);
        return record;
      } catch (error) {
        if (error?.code !== "EEXIST")
          throw error;
      }
    } finally {
      try {
        unlinkSync(candidate);
      } catch (error) {
        if (error?.code !== "ENOENT")
          throw error;
      }
    }
    if (reclaimProvablyDeadLock(topicId))
      continue;
    if (Date.now() - start >= timeoutMs)
      return null;
    Atomics.wait(lockWait, 0, 0, 10);
  }
}
function assertLockOwnership(topicId, lock) {
  const actual = readLock(topicId);
  if (!actual || actual.token !== lock.token) {
    throw new Error(`Lost fenced lock ownership for topic "${topicId}"`);
  }
}
function releaseLock(topicId, lock) {
  const path = lockPath(topicId);
  try {
    const actual = readLock(topicId);
    if (!actual || actual.token !== lock.token)
      return;
    unlinkSync(path);
  } catch (error) {
    if (error?.code !== "ENOENT")
      throw error;
  }
}
function writeDurableTemporary(path, content) {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let descriptor;
  try {
    descriptor = openSync(temporary, "wx", 384);
    writeFileSync(descriptor, content, "utf-8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    return temporary;
  } catch (error) {
    if (descriptor !== undefined)
      closeSync(descriptor);
    try {
      unlinkSync(temporary);
    } catch (unlinkError) {
      if (unlinkError?.code !== "ENOENT")
        throw unlinkError;
    }
    throw error;
  }
}
function atomicWriteFile(path, content) {
  const temporary = writeDurableTemporary(path, content);
  try {
    renameSync(temporary, path);
  } finally {
    try {
      unlinkSync(temporary);
    } catch (error) {
      if (error?.code !== "ENOENT")
        throw error;
    }
  }
}
function atomicCreateFile(path, content) {
  const temporary = writeDurableTemporary(path, content);
  try {
    linkSync(temporary, path);
  } finally {
    try {
      unlinkSync(temporary);
    } catch (error) {
      if (error?.code !== "ENOENT")
        throw error;
    }
  }
}
function validateActor(actor) {
  if (!actor)
    return null;
  if (typeof actor.id !== "string" || actor.id.trim() === "")
    return "actor.id is not a non-empty string";
  if (actor.label !== undefined && typeof actor.label !== "string")
    return "actor.label is not a string";
  if (actor.parentSession !== undefined && typeof actor.parentSession !== "string")
    return "actor.parentSession is not a string";
  return null;
}
function validateRelations(relations) {
  if (!relations)
    return null;
  const allowed = new Set(["supports", "depends-on", "conflicts-with", "duplicate-of", "child-of"]);
  for (const relation of relations) {
    if (!relation || !allowed.has(relation.type) || typeof relation.topic !== "string" || relation.topic.length === 0 || /[\\/\0]/.test(relation.topic)) {
      return "relation is invalid";
    }
  }
  return null;
}
function validateRefs(refs) {
  if (!refs)
    return null;
  for (const ref of refs) {
    if (!ref || typeof ref.topic !== "string" || ref.topic.length === 0 || /[\\/\0]/.test(ref.topic) || !Number.isInteger(ref.seq) || ref.seq < 1)
      return "target reference is invalid";
  }
  return null;
}
function isStructuredKind(kind) {
  return ["declare", "plan", "claim", "evidence", "challenge", "verification", "decision", "retraction", "convergence"].includes(String(kind));
}
function validateStructuredNote(note) {
  if (note.actor && validateActor(note.actor))
    return validateActor(note.actor);
  if (note.kind !== undefined && !isStructuredKind(note.kind))
    return "note kind is invalid";
  if (note.targets && validateRefs(note.targets))
    return validateRefs(note.targets);
  if (note.relations && validateRelations(note.relations))
    return validateRelations(note.relations);
  if (note.material !== undefined && typeof note.material !== "boolean")
    return "material is not boolean";
  if (note.verdict !== undefined && typeof note.verdict !== "string")
    return "verdict is not a string";
  if (note.unresolved && validateRefs(note.unresolved))
    return validateRefs(note.unresolved);
  if (note.kind && !note.actor)
    return "structured note requires runtime actor";
  if (note.kind === "claim" && note.material && (!note.targets || note.targets.length === 0)) {}
  if (["challenge", "verification", "retraction"].includes(note.kind ?? "") && (!note.targets || note.targets.length === 0)) {
    return `${note.kind} requires at least one target`;
  }
  if (note.kind === "convergence" && (!note.verdict || !note.actor))
    return "convergence requires actor and verdict";
  return null;
}
function readActiveTopic(topicId) {
  recoverCloseTransaction(topicId);
  const jsonlPath = topicJsonlPath(topicId);
  if (!existsSync3(jsonlPath))
    throw new Error(`Topic "${topicId}" not found`);
  const lines = readFileSync2(jsonlPath, "utf-8").split(`
`).filter((l) => l.trim());
  if (!lines[0]?.startsWith("#META#"))
    throw new Error(`Topic "${topicId}" JSONL is corrupted: missing META line`);
  let topic;
  try {
    topic = JSON.parse(lines[0].slice(6));
  } catch {
    throw new Error(`Topic "${topicId}" JSONL is corrupted: META line is not valid JSON`);
  }
  const topicShapeIssue = validateTopicShape(topic);
  if (topicShapeIssue)
    throw new Error(`Topic "${topicId}" JSONL is corrupted: META shape invalid: ${topicShapeIssue}`);
  if (topic.id !== topicId || topic.status !== "open")
    throw new Error(`Topic "${topicId}" JSONL is corrupted: META identity/status mismatch (${topic.id}/${topic.status})`);
  if (validateActor(topic.createdBy))
    throw new Error(`Topic "${topicId}" JSONL is corrupted: ${validateActor(topic.createdBy)}`);
  if (validateRelations(topic.relations))
    throw new Error(`Topic "${topicId}" JSONL is corrupted: ${validateRelations(topic.relations)}`);
  const notes = [];
  for (let i = 1;i < lines.length; i += 1) {
    let note;
    try {
      note = JSON.parse(lines[i]);
    } catch {
      throw new Error(`Topic "${topicId}" JSONL is corrupted: line ${i + 1} is not valid JSON`);
    }
    const shapeIssue = validateNoteShape(note);
    if (shapeIssue)
      throw new Error(`Topic "${topicId}" JSONL is corrupted: line ${i + 1} shape invalid: ${shapeIssue}`);
    const structuredIssue = validateStructuredNote(note);
    if (structuredIssue)
      throw new Error(`Topic "${topicId}" JSONL is corrupted: line ${i + 1} ${structuredIssue}`);
    notes.push(note);
  }
  const seqIssues = validateNoteSeq(notes);
  if (seqIssues.length > 0)
    throw new Error(`Topic "${topicId}" JSONL is corrupted (seq gap/rollback — external rewrite or Git conflict?): ${seqIssues.join("; ")}`);
  return { topic, notes };
}
function readAnyTopic(topicId) {
  if (existsSync3(topicJsonlPath(topicId)))
    return readActiveTopic(topicId);
  if (existsSync3(archivedTopicJsonlPath(topicId))) {
    const archived = readArchivedTopic(topicId);
    return { topic: archived.topic, notes: archived.notes };
  }
  throw new Error(`Topic "${topicId}" not found`);
}
function validateTargets(topicId, topic, notes, note) {
  const targets = note.targets ?? [];
  const refs = [...targets, ...note.unresolved ?? []];
  for (const target of refs) {
    if (target.topic !== topicId) {
      const declared = [...topic.relations ?? [], ...notes.flatMap((candidate) => candidate.relations ?? []), ...note.relations ?? []].some((relation) => relation.topic === target.topic);
      if (!declared)
        throw new Error(`Cross-topic target ${target.topic} requires a declared relation`);
    }
    const targetRecord = target.topic === topicId ? notes.find((candidate) => candidate.seq === target.seq) : readAnyTopic(target.topic).notes.find((candidate) => candidate.seq === target.seq);
    if (!targetRecord)
      throw new Error(`Note target ${target.topic}#${target.seq} does not exist`);
    if (!targets.some((ref) => ref.topic === target.topic && ref.seq === target.seq))
      continue;
    if (note.kind === "challenge" && !["claim", "evidence", "decision"].includes(targetRecord.kind ?? ""))
      throw new Error("challenge target must be claim, evidence, or decision");
    if (note.kind === "verification" && targetRecord.kind !== "claim")
      throw new Error("verification target must be claim");
  }
}
function openTopic(topicId, goal, opts = {}) {
  const jsonlPath = topicJsonlPath(topicId);
  const lock = acquireLock(topicId);
  if (!lock)
    throw new Error(`Failed to acquire lock for topic "${topicId}" (timeout; existing owner was not provably dead)`);
  try {
    assertLockOwnership(topicId, lock);
    if (hasArchivedTopic(topicId))
      throw new Error(`Topic "${topicId}" already exists in archive`);
    const actorIssue = validateActor(opts.actor);
    if (actorIssue)
      throw new Error(`Topic rejected before write: ${actorIssue}`);
    const relationsIssue = validateRelations(opts.relations);
    if (relationsIssue)
      throw new Error(`Topic rejected before write: ${relationsIssue}`);
    const topic = { id: topicId, goal, status: "open", createdAt: Date.now(), ...opts.actor && { createdBy: opts.actor }, ...opts.relations && { relations: opts.relations } };
    const shapeIssue = validateTopicShape(topic);
    if (shapeIssue)
      throw new Error(`Topic "${topicId}" rejected before write: ${shapeIssue}`);
    try {
      atomicCreateFile(jsonlPath, `#META#${JSON.stringify(topic)}
`);
    } catch (error) {
      if (error?.code === "EEXIST")
        throw new Error(`Topic "${topicId}" already exists`);
      throw error;
    }
    assertLockOwnership(topicId, lock);
    renderBoardMd(topicId, topic, []);
    appendEvent("board_open", {
      topic: topicId,
      goalBytes: Buffer.byteLength(goal, "utf-8"),
      goalDigest: createHash("sha256").update(goal, "utf-8").digest("hex"),
      actorId: opts.actor?.id
    });
    return topic;
  } finally {
    releaseLock(topicId, lock);
  }
}
function postNote(topicId, author, content, opts = {}) {
  const jsonlPath = topicJsonlPath(topicId);
  if (!existsSync3(jsonlPath))
    throw new Error(`Topic "${topicId}" not found`);
  recoverCloseTransaction(topicId);
  const lock = acquireLock(topicId);
  if (!lock)
    throw new Error(`Failed to acquire lock for topic "${topicId}" (timeout; existing owner was not provably dead)`);
  try {
    assertLockOwnership(topicId, lock);
    const { topic, notes } = readActiveTopic(topicId);
    const seq = notes.length > 0 ? notes[notes.length - 1].seq + 1 : 1;
    const note = {
      seq,
      author,
      timestamp: Date.now(),
      content,
      ...opts.tags && { tags: opts.tags },
      ...opts.priority && { priority: opts.priority },
      ...opts.actor && { actor: opts.actor },
      ...opts.kind && { kind: opts.kind },
      ...opts.targets && { targets: opts.targets },
      ...opts.relations && { relations: opts.relations },
      ...opts.material !== undefined && { material: opts.material },
      ...opts.verdict && { verdict: opts.verdict },
      ...opts.unresolved && { unresolved: opts.unresolved }
    };
    const shapeIssue = validateNoteShape(note);
    if (shapeIssue)
      throw new Error(`Note rejected before write on topic "${topicId}": ${shapeIssue}`);
    const structuredIssue = validateStructuredNote(note);
    if (structuredIssue)
      throw new Error(`Note rejected before write on topic "${topicId}": ${structuredIssue}`);
    validateTargets(topicId, topic, notes, note);
    assertLockOwnership(topicId, lock);
    appendFileSync2(jsonlPath, JSON.stringify(note) + `
`, "utf-8");
    const after = readActiveTopic(topicId);
    const persisted = after.notes.at(-1);
    if (after.notes.length !== notes.length + 1 || JSON.stringify(persisted) !== JSON.stringify(note))
      throw new Error(`Topic "${topicId}" append verification failed: note #${seq} not persisted intact`);
    assertLockOwnership(topicId, lock);
    renderBoardMd(topicId, after.topic, after.notes);
    appendEvent("board_post", { topic: topicId, seq, author, actorId: opts.actor?.id, kind: opts.kind });
    return note;
  } finally {
    releaseLock(topicId, lock);
  }
}
function readNotes(topicId, since) {
  recoverBoardTransactions();
  const { notes } = readActiveTopic(topicId);
  return since === undefined ? notes : notes.filter((note) => note.seq > since);
}
function readArchivedTopic(topicId) {
  recoverCloseTransaction(topicId);
  const report = assertArchivedTopicIntact(topicId);
  const jsonlPath = archivedTopicJsonlPath(topicId);
  const lines = readFileSync2(jsonlPath, "utf-8").split(`
`).filter((line) => line.trim());
  const metaLine = lines[0];
  if (!metaLine?.startsWith("#META#"))
    throw new Error(`Invalid archived topic file: missing META line for "${topicId}"`);
  const topic = JSON.parse(metaLine.slice(6));
  if (topic.id !== topicId || topic.status !== "closed")
    throw new Error(`Invalid archived topic identity or status for "${topicId}"`);
  if (validateActor(topic.createdBy) || validateActor(topic.closedBy) || validateRelations(topic.relations)) {
    throw new Error(`Invalid archived topic metadata for "${topicId}"`);
  }
  const notes = lines.slice(1).map((line) => JSON.parse(line));
  for (const note of notes) {
    const issue = validateStructuredNote(note);
    if (issue)
      throw new Error(`Invalid archived topic "${topicId}": ${issue}`);
  }
  return { topic, notes, integrity: report.witnessKind };
}
function listTopics() {
  recoverBoardTransactions();
  const dir = topicsDir();
  const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
  const topics = [];
  for (const file of files) {
    const topicId = file.replace(".jsonl", "");
    const { topic, notes } = readActiveTopic(topicId);
    topics.push({ ...topic, noteCount: notes.length });
  }
  const archiveDir = join4(dir, "archive");
  if (existsSync3(archiveDir))
    for (const file of readdirSync(archiveDir).filter((f) => f.endsWith(".jsonl"))) {
      const topicId = file.replace(".jsonl", "");
      const archived = readArchivedTopic(topicId);
      topics.push({ ...archived.topic, noteCount: archived.notes.length, integrity: archived.integrity });
    }
  return topics;
}
function listOpenTopics() {
  recoverBoardTransactions();
  const files = readdirSync(topicsDir()).filter((file) => file.endsWith(".jsonl"));
  const topics = [];
  for (const file of files) {
    const topicId = file.slice(0, -".jsonl".length);
    try {
      topics.push(readActiveTopic(topicId).topic);
    } catch (error) {
      if (error?.code !== "ENOENT")
        throw error;
    }
  }
  return topics;
}
function catalogEntry(topic, notes, integrity) {
  const critical = notes.filter((note) => note.priority === "critical");
  const participants = [...new Set([topic.createdBy?.id, ...notes.map((note) => note.actor?.id)].filter((value) => Boolean(value)))].sort();
  const relations = [...topic.relations ?? [], ...notes.flatMap((note) => note.relations ?? [])];
  return {
    ...topic,
    noteCount: notes.length,
    ...integrity && { integrity },
    lastActivityAt: notes.at(-1)?.timestamp ?? topic.createdAt,
    lastSeq: notes.at(-1)?.seq ?? 0,
    criticalCount: critical.length,
    ...critical.at(-1) && { lastCriticalSeq: critical.at(-1).seq },
    participants,
    relations
  };
}
function listOpenTopicCatalog() {
  recoverBoardTransactions();
  return listOpenTopics().map((topic) => {
    const { notes } = readActiveTopic(topic.id);
    return catalogEntry(topic, notes);
  }).sort((left, right) => left.id.localeCompare(right.id));
}
function getTopicCatalogEntry(topicId) {
  recoverBoardTransactions();
  if (existsSync3(topicJsonlPath(topicId))) {
    const { topic, notes } = readActiveTopic(topicId);
    return catalogEntry(topic, notes);
  }
  const archived = readArchivedTopic(topicId);
  return catalogEntry(archived.topic, archived.notes, archived.integrity);
}
function listTopicCatalog() {
  return listTopics().map((meta) => getTopicCatalogEntry(meta.id)).sort((left, right) => left.id.localeCompare(right.id));
}
function refKey(ref) {
  return `${ref.topic}#${ref.seq}`;
}
function noteRef(topic, note) {
  return { topic, seq: note.seq };
}
function activeNotes(topicId, notes) {
  const retracted = new Set;
  const active = [];
  for (const note of [...notes].reverse()) {
    const ref = refKey(noteRef(topicId, note));
    if (retracted.has(ref))
      continue;
    active.push(note);
    if (note.kind === "retraction") {
      for (const target of note.targets ?? [])
        retracted.add(refKey(target));
    }
  }
  return active.reverse();
}
function assessCloseReadiness(topicId) {
  const { topic, notes } = readActiveTopic(topicId);
  const active = activeNotes(topicId, notes);
  const convergence = [...active].reverse().find((note) => note.kind === "convergence" && note.actor);
  const materialClaims = active.filter((note) => note.kind === "claim" && note.material);
  const materialClaimKeys = new Set(materialClaims.map((note) => refKey(noteRef(topicId, note))));
  const activeChallenges = [];
  const challengeStreams = [{ topic: topicId, notes }];
  for (const candidate of listTopics()) {
    if (candidate.id === topicId)
      continue;
    challengeStreams.push({ topic: candidate.id, notes: readAnyTopic(candidate.id).notes });
  }
  for (const stream of challengeStreams) {
    for (const challenge of activeNotes(stream.topic, stream.notes).filter((note) => note.kind === "challenge")) {
      if ((challenge.targets ?? []).some((target) => materialClaimKeys.has(refKey(target)))) {
        activeChallenges.push({ note: challenge, ref: noteRef(stream.topic, challenge), originTopic: stream.topic });
      }
    }
  }
  const accepted = new Set(convergence?.unresolved?.map(refKey) ?? []);
  const verifiedAt = new Map;
  const decidedAt = new Map;
  for (const note of active) {
    if (note.kind === "verification")
      for (const target of note.targets ?? [])
        verifiedAt.set(refKey(target), note.seq);
    if (note.kind === "decision")
      for (const target of note.targets ?? [])
        decidedAt.set(refKey(target), note.seq);
  }
  const convergenceSeq = convergence?.seq ?? -1;
  const openMaterialClaims = materialClaims.filter((note) => note.seq > convergenceSeq || (verifiedAt.get(refKey(noteRef(topicId, note))) ?? Infinity) > convergenceSeq && !accepted.has(refKey(noteRef(topicId, note)))).map((note) => noteRef(topicId, note));
  const openChallenges = activeChallenges.filter(({ note, ref, originTopic }) => {
    if (accepted.has(refKey(ref)))
      return false;
    const decisionSeq = decidedAt.get(refKey(ref));
    if (originTopic !== topicId)
      return decisionSeq === undefined || decisionSeq > convergenceSeq;
    return note.seq > convergenceSeq || decisionSeq === undefined || decisionSeq > convergenceSeq;
  }).map(({ ref }) => ref);
  if (!convergence)
    return { ready: false, reason: "no structured convergence verdict", openMaterialClaims, openChallenges };
  if (openMaterialClaims.length > 0) {
    return { ready: false, reason: "open material claims lack active verification or explicit unresolved acceptance", convergence, openMaterialClaims, openChallenges };
  }
  if (openChallenges.length > 0) {
    return { ready: false, reason: "open material-claim challenges", convergence, openMaterialClaims, openChallenges };
  }
  if (!topic.createdBy && !notes.some((note) => note.kind !== undefined)) {
    return { ready: true, convergence: undefined, openMaterialClaims: [], openChallenges: [] };
  }
  return { ready: true, convergence, openMaterialClaims: [], openChallenges: [] };
}
function closeTopic(topicId, opts = {}) {
  recoverCloseTransaction(topicId);
  const lock = acquireLock(topicId);
  if (!lock)
    throw new Error(`Failed to acquire lock for topic "${topicId}" (timeout; existing owner was not provably dead)`);
  try {
    assertLockOwnership(topicId, lock);
    const { topic, notes } = readActiveTopic(topicId);
    const legacy = !topic.createdBy && !notes.some((note) => note.kind !== undefined);
    const readiness = assessCloseReadiness(topicId);
    if (!legacy && !readiness.ready)
      throw new Error(`Board close blocked: ${readiness.reason}`);
    const actorIssue = validateActor(opts.actor);
    if (actorIssue)
      throw new Error(`Board close rejected: ${actorIssue}`);
    const summary = generateSummary(topic, notes);
    const decisions = generateDecisions(topic, notes);
    const archiveDir = join4(topicsDir(), "archive");
    ensureDir(archiveDir);
    ensureDir(join4(topicsDir(), ".transactions"));
    const activeJsonl = topicJsonlPath(topicId);
    const activeBoardMd = topicBoardMdPath(topicId);
    const archiveJsonl = archivedTopicJsonlPath(topicId);
    const archiveBoardMd = join4(archiveDir, `${topicId}.board.md`);
    const archiveSummary = join4(archiveDir, `${topicId}.summary.md`);
    const archiveDecisions = join4(archiveDir, `${topicId}.decisions.md`);
    const collisions = [archiveJsonl, archiveBoardMd, archiveSummary, archiveDecisions].filter(existsSync3);
    if (collisions.length > 0)
      throw new Error(`Archive collision for topic "${topicId}"; active topic was preserved (${collisions.length} existing artifact${collisions.length === 1 ? "" : "s"})`);
    const closedMeta = { ...topic, status: "closed", closedAt: Date.now(), ...opts.actor && { closedBy: opts.actor }, integrityVersion: 1, finalSeq: notes.length };
    const journal = { version: 1, topicId, token: lock.token, activeJsonl, activeBoardMd, archiveJsonl, archiveBoardMd, archiveSummary, archiveDecisions, closedMeta, summary, decisions, phase: "prepared" };
    atomicCreateFile(journalPath(topicId), JSON.stringify(journal));
    assertLockOwnership(topicId, lock);
    const lines = readFileSync2(activeJsonl, "utf-8").split(`
`);
    lines[0] = `#META#${JSON.stringify(closedMeta)}`;
    atomicWriteFile(activeJsonl, lines.join(`
`));
    renameSync(activeJsonl, archiveJsonl);
    journal.phase = "jsonl-committed";
    atomicWriteFile(journalPath(topicId), JSON.stringify(journal));
    finalizeCloseJournal(journal);
    assertLockOwnership(topicId, lock);
    appendEvent("board_close", { topic: topicId, actorId: opts.actor?.id });
    return { summary, decisions };
  } finally {
    releaseLock(topicId, lock);
  }
}
function parseRecoverableTopicFile(topicId, path, statuses) {
  const lines = readFileSync2(path, "utf-8").split(`
`).filter((line) => line.trim());
  if (!lines[0]?.startsWith("#META#"))
    throw new Error(`Close recovery for "${topicId}" has invalid source META; journal preserved`);
  let topic;
  try {
    topic = JSON.parse(lines[0].slice(6));
  } catch {
    throw new Error(`Close recovery for "${topicId}" has invalid source META JSON; journal preserved`);
  }
  if (topic.id !== topicId || !statuses.includes(topic.status) || validateTopicShape(topic)) {
    throw new Error(`Close recovery for "${topicId}" has invalid source identity/status/shape; journal preserved`);
  }
  const notes = [];
  for (let index = 1;index < lines.length; index += 1) {
    let note;
    try {
      note = JSON.parse(lines[index]);
    } catch {
      throw new Error(`Close recovery for "${topicId}" has torn note bytes; journal preserved`);
    }
    if (validateNoteShape(note) || validateStructuredNote(note)) {
      throw new Error(`Close recovery for "${topicId}" has invalid note shape; journal preserved`);
    }
    notes.push(note);
  }
  if (validateNoteSeq(notes).length > 0)
    throw new Error(`Close recovery for "${topicId}" has non-contiguous notes; journal preserved`);
  return { topic, notes };
}
function finalizeCloseJournal(journal) {
  ensureDir(join4(topicsDir(), "archive"));
  if (!existsSync3(journal.archiveJsonl))
    throw new Error(`Close recovery for "${journal.topicId}" lacks archive JSONL after commit point`);
  if (existsSync3(journal.activeBoardMd) && !existsSync3(journal.archiveBoardMd))
    renameSync(journal.activeBoardMd, journal.archiveBoardMd);
  if (!existsSync3(journal.archiveBoardMd)) {
    const archived = parseRecoverableTopicFile(journal.topicId, journal.archiveJsonl, ["closed"]);
    writeBoardMd(journal.archiveBoardMd, journal.topicId, archived.topic, archived.notes);
  }
  if (!existsSync3(journal.archiveSummary))
    atomicCreateFile(journal.archiveSummary, journal.summary);
  if (!existsSync3(journal.archiveDecisions))
    atomicCreateFile(journal.archiveDecisions, journal.decisions);
  journal.phase = "complete";
  atomicWriteFile(journalPath(journal.topicId), JSON.stringify(journal));
  unlinkSync(journalPath(journal.topicId));
}
function recoverCloseTransaction(topicId) {
  const path = journalPath(topicId);
  if (!existsSync3(path))
    return;
  let journal;
  try {
    journal = JSON.parse(readFileSync2(path, "utf-8"));
  } catch {
    throw new Error(`Close recovery journal for "${topicId}" is invalid; evidence preserved`);
  }
  if (journal.version !== 1 || journal.topicId !== topicId || typeof journal.token !== "string" || journal.token.length === 0) {
    throw new Error(`Close recovery journal for "${topicId}" has invalid identity/token; evidence preserved`);
  }
  const owner = readLock(topicId);
  const currentStart = processStartIdentity(process.pid);
  if (owner && owner.token !== journal.token) {
    throw new Error(`Close recovery journal for "${topicId}" lock token mismatch; evidence preserved`);
  }
  if (owner && owner.pid === process.pid && owner.processStart === currentStart)
    return;
  if (owner && !ownerIsProvablyDead(owner))
    return;
  if (owner && ownerIsProvablyDead(owner) && !reclaimProvablyDeadLock(topicId)) {
    return;
  }
  if (existsSync3(journal.archiveJsonl)) {
    finalizeCloseJournal(journal);
    return;
  }
  if (!existsSync3(journal.activeJsonl))
    throw new Error(`Close recovery for "${topicId}" has neither active nor archive JSONL; evidence preserved`);
  const source = parseRecoverableTopicFile(topicId, journal.activeJsonl, ["open", "closed"]);
  if (source.topic.status === "closed") {
    const restored = { ...source.topic, status: "open" };
    delete restored.closedAt;
    delete restored.closedBy;
    delete restored.integrityVersion;
    delete restored.finalSeq;
    const lines = readFileSync2(journal.activeJsonl, "utf-8").split(`
`);
    lines[0] = `#META#${JSON.stringify(restored)}`;
    atomicWriteFile(journal.activeJsonl, lines.join(`
`));
  }
  parseRecoverableTopicFile(topicId, journal.activeJsonl, ["open"]);
  unlinkSync(path);
}
function recoverAllCloseTransactions() {
  const dir = join4(topicsDir(), ".transactions");
  if (!existsSync3(dir))
    return;
  for (const file of readdirSync(dir).filter((file) => file.endsWith(".close.json")))
    recoverCloseTransaction(file.slice(0, -".close.json".length));
}
function recoverOpenTransactions() {
  for (const file of readdirSync(topicsDir()).filter((file) => file.endsWith(".jsonl"))) {
    const topicId = file.slice(0, -".jsonl".length);
    const boardPath = topicBoardMdPath(topicId);
    if (existsSync3(boardPath))
      continue;
    const { topic, notes } = readActiveTopic(topicId);
    renderBoardMd(topicId, topic, notes);
  }
}
function recoverBoardTransactions() {
  recoverAllCloseTransactions();
  recoverOpenTransactions();
}
function boardMdContent(topicId, topic, notes) {
  let md = `# Topic: ${topicId}

**Goal**: ${topic.goal}
**Status**: ${topic.status}
**Created**: ${new Date(topic.createdAt).toISOString()}
`;
  if (topic.createdBy)
    md += `**Created by**: ${topic.createdBy.label ?? topic.createdBy.id} (${topic.createdBy.id})
`;
  md += `
---

`;
  for (const note of notes) {
    const priorityTag = note.priority === "critical" ? " \uD83D\uDD34 CRITICAL" : "";
    const tagsStr = note.tags?.length ? ` [${note.tags.join(", ")}]` : "";
    const kind = note.kind ? ` {${note.kind}${note.material ? ", material" : ""}}` : "";
    const actor = note.actor ? ` (${note.actor.id})` : "";
    md += `### #${note.seq} — ${note.author}${actor}${priorityTag}${tagsStr}${kind}
*${new Date(note.timestamp).toISOString()}*

${note.content}

`;
  }
  return md;
}
function writeBoardMd(path, topicId, topic, notes) {
  atomicWriteFile(path, boardMdContent(topicId, topic, notes));
}
function renderBoardMd(topicId, topic, notes) {
  writeBoardMd(topicBoardMdPath(topicId), topicId, topic, notes);
}
function generateSummary(topic, notes) {
  let md = `<!-- PI_BOARD_SUMMARY v1 totalNotes=${notes.length} -->
# Summary: ${topic.id}

**Goal**: ${topic.goal}
**Duration**: ${new Date(topic.createdAt).toISOString()} → ${new Date(Date.now()).toISOString()}
**Total Notes**: ${notes.length}
**Participants**: ${[...new Set(notes.map((n) => n.author))].join(", ")}

## Discussion Highlights

`;
  const critical = notes.filter((n) => n.priority === "critical");
  if (critical.length) {
    md += `### Critical Notes

`;
    for (const n of critical)
      md += `- [#${n.seq}] ${n.author}: ${n.content}
`;
    md += `
`;
  }
  md += `### Complete Activity

`;
  for (const n of notes)
    md += `- [#${n.seq}] ${n.author}: ${n.content}
`;
  return md;
}
function generateDecisions(topic, notes) {
  let md = `# Decisions: ${topic.id}

**Goal**: ${topic.goal}

## Key Findings & Decisions

`;
  for (const n of notes.filter((n) => n.priority === "critical"))
    md += `### Decision from ${n.author} (seq #${n.seq})

${n.content}

`;
  if (notes.length) {
    const last = notes.at(-1);
    md += `### Final Note (seq #${last.seq}, by ${last.author})

${last.content}

`;
  }
  return `${md}---

*Generated at topic close. Use \`distill\` to elevate conclusions to knowledge.*
`;
}
// core/knowledge/index.ts
import {
  existsSync as existsSync4,
  lstatSync,
  mkdirSync as mkdirSync3,
  readFileSync as readFileSync3,
  renameSync as renameSync2,
  unlinkSync as unlinkSync2,
  writeFileSync as writeFileSync2
} from "node:fs";
import { dirname as dirname2, isAbsolute, join as join5, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";
var RETIRED_STATUS_BY_TAG = {
  SUPERSEDED: "superseded",
  ARCHIVED: "archived",
  DEPRECATED: "deprecated"
};
var STATUS_TAG_PATTERN = /^\[(SUPERSEDED|ARCHIVED|DEPRECATED)\]\s*/i;
function assertScope(scope) {
  if (scope !== "project" && scope !== "workspace" && scope !== "global") {
    throw new Error(`Invalid knowledge scope "${String(scope)}"`);
  }
}
function getProjectRoot(startDir = process.cwd()) {
  return resolve(scopedProjectRoot() ?? startDir);
}
function getWorkspaceRoot(startDir = process.cwd()) {
  const projectRoot = getProjectRoot(startDir);
  let current = projectRoot;
  while (true) {
    if (existsSync4(join5(current, ".git")))
      return current;
    const parent = dirname2(current);
    if (parent === current)
      return projectRoot;
    current = parent;
  }
}
function getKnowledgeRoot(scope = "project") {
  assertScope(scope);
  const dshRoot = scopedProjectRoot();
  if (dshRoot !== undefined) return dshKnowledgeRoot(dshRoot, scope);
  if (scope === "global")
    return join5(homedir(), ".pi-harness", "knowledge");
  if (scope === "workspace")
    return join5(getWorkspaceRoot(), "knowledge");
  return join5(getProjectRoot(), "knowledge");
}
function getIndexPath(scope) {
  return join5(getKnowledgeRoot(scope), "index.md");
}
function isSymlink(path) {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch (error) {
    if (error?.code === "ENOENT")
      return false;
    throw error;
  }
}
function assertNoSymlinkComponents(root, fullPath) {
  const rel = relative(root, fullPath);
  let current = root;
  if (isSymlink(current)) {
    throw new Error(`Knowledge root must not be a symlink: "${root}"`);
  }
  for (const component of rel.split(sep).filter(Boolean)) {
    current = join5(current, component);
    if (isSymlink(current)) {
      throw new Error(`Knowledge path must not traverse a symlink: "${current}"`);
    }
  }
}
function resolveEntryPath(entryPath, scope) {
  if (typeof entryPath !== "string" || entryPath.trim() === "") {
    throw new Error("Knowledge entry path is required");
  }
  if (entryPath.includes("\x00") || /[\r\n|]/.test(entryPath)) {
    throw new Error(`Invalid knowledge entry path "${entryPath}"`);
  }
  if (isAbsolute(entryPath)) {
    throw new Error(`Knowledge entry path must be relative: "${entryPath}"`);
  }
  const root = getKnowledgeRoot(scope);
  const fullPath = resolve(root, entryPath);
  const rel = relative(root, fullPath);
  const outsideRoot = rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
  if (!rel || outsideRoot) {
    throw new Error(`Knowledge entry path escapes the ${scope} root: "${entryPath}"`);
  }
  if (rel === "index.md") {
    throw new Error('"index.md" is reserved for the knowledge index');
  }
  assertNoSymlinkComponents(root, fullPath);
  return fullPath;
}
function assertSingleLine(value, field) {
  if (!value || value.trim() === "" || /[\r\n]/.test(value)) {
    throw new Error(`${field} must be a non-empty single line`);
  }
}
function atomicWrite(path, content) {
  const tmpPath = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  try {
    writeFileSync2(tmpPath, content, { encoding: "utf-8", flag: "wx" });
    renameSync2(tmpPath, path);
  } finally {
    if (existsSync4(tmpPath))
      unlinkSync2(tmpPath);
  }
}
function recordKnowledgeEvent(details) {
  try {
    appendEvent("distill", details);
  } catch {}
}
function getIndex(scope = "project") {
  const indexPath = getIndexPath(scope);
  assertNoSymlinkComponents(getKnowledgeRoot(scope), indexPath);
  if (!existsSync4(indexPath))
    return [];
  const content = readFileSync3(indexPath, "utf-8");
  const entries = [];
  for (const line of content.split(`
`)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("<!--"))
      continue;
    const tag = STATUS_TAG_PATTERN.exec(trimmed);
    const status = tag ? RETIRED_STATUS_BY_TAG[tag[1].toUpperCase()] : "active";
    const row = tag ? trimmed.slice(tag[0].length) : trimmed;
    const pipeIndex = row.indexOf("|");
    if (pipeIndex === -1)
      continue;
    const path = row.slice(0, pipeIndex).trim();
    const description = row.slice(pipeIndex + 1).trim();
    if (path && description)
      entries.push({ path, description, status });
  }
  return entries;
}
function auditIndex(scope = "project") {
  return getIndex(scope).flatMap((entry) => {
    try {
      const fullPath = resolveEntryPath(entry.path, scope);
      return existsSync4(fullPath) ? [] : [{ path: entry.path, reason: "missing" }];
    } catch (error) {
      return [{ path: entry.path, reason: "invalid", detail: error?.message }];
    }
  });
}
function getEntry(entryPath, scope = "project") {
  const fullPath = resolveEntryPath(entryPath, scope);
  if (!existsSync4(fullPath))
    return null;
  return readFileSync3(fullPath, "utf-8");
}
function addEntry(entryPath, content, sourceLink, description, scope = "project") {
  assertSingleLine(sourceLink, "Source link");
  assertSingleLine(description, "Description");
  const fullPath = resolveEntryPath(entryPath, scope);
  if (existsSync4(fullPath)) {
    throw new Error(`Entry "${entryPath}" already exists. Use markConflict() if the new finding contradicts it, or choose a different path.`);
  }
  const dir = dirname2(fullPath);
  mkdirSync3(dir, { recursive: true });
  assertNoSymlinkComponents(getKnowledgeRoot(scope), fullPath);
  const entryContent = `${content.trim()}

---

来源: ${sourceLink}
`;
  writeFileSync2(fullPath, entryContent, { encoding: "utf-8", flag: "wx" });
  try {
    updateIndex(entryPath, description, scope);
  } catch (error) {
    if (existsSync4(fullPath))
      unlinkSync2(fullPath);
    throw error;
  }
  recordKnowledgeEvent({
    action: "add_entry",
    path: entryPath,
    source: sourceLink,
    scope
  });
}
function markConflict(existingPath, newSourceLink, conflictDescription, scope = "project") {
  assertSingleLine(newSourceLink, "Source link");
  if (!conflictDescription || conflictDescription.trim() === "") {
    throw new Error("Conflict description is required");
  }
  const fullPath = resolveEntryPath(existingPath, scope);
  if (!existsSync4(fullPath)) {
    throw new Error(`Entry "${existingPath}" not found — cannot mark conflict`);
  }
  const currentContent = readFileSync3(fullPath, "utf-8");
  const conflictBlock = `

## ⚠️ CONFLICT (${new Date().toISOString()})

` + `**New evidence contradicts this entry.**

` + `${conflictDescription}

` + `来源: ${newSourceLink}
`;
  atomicWrite(fullPath, currentContent + conflictBlock);
  recordKnowledgeEvent({
    action: "mark_conflict",
    path: existingPath,
    newSource: newSourceLink,
    scope
  });
}
function updateIndex(entryPath, description, scope) {
  const indexPath = getIndexPath(scope);
  const root = getKnowledgeRoot(scope);
  assertNoSymlinkComponents(root, indexPath);
  mkdirSync3(root, { recursive: true });
  assertNoSymlinkComponents(root, indexPath);
  const content = existsSync4(indexPath) ? readFileSync3(indexPath, "utf-8") : "";
  const lines = content.split(`
`);
  let found = false;
  const updated = lines.map((line) => {
    const pipeIndex = line.indexOf("|");
    if (pipeIndex === -1)
      return line;
    const rawPath = line.slice(0, pipeIndex).trim();
    const tag = STATUS_TAG_PATTERN.exec(rawPath);
    const indexedPath = tag ? rawPath.slice(tag[0].length).trim() : rawPath;
    if (indexedPath !== entryPath)
      return line;
    found = true;
    return `${entryPath} | ${description}`;
  });
  const nextContent = found ? updated.join(`
`) : `${content.trimEnd()}${content.trimEnd() ? `
` : ""}${entryPath} | ${description}
`;
  atomicWrite(indexPath, nextContent);
}
// core/field/index.ts
import {
  appendFileSync as appendFileSync3,
  existsSync as existsSync5,
  linkSync as linkSync2,
  mkdirSync as mkdirSync4,
  readdirSync as readdirSync2,
  readFileSync as readFileSync4,
  renameSync as renameSync3,
  statSync,
  unlinkSync as unlinkSync3,
  writeFileSync as writeFileSync3
} from "node:fs";
import { createHash as createHash2, randomUUID as randomUUID2 } from "node:crypto";
import { hostname } from "node:os";
import { basename, dirname as dirname3, join as join6, relative as relative2, resolve as resolve2 } from "node:path";
var PULSE_KINDS = [
  "echo",
  "need",
  "conflict",
  "breach",
  "artifact"
];
var CROSS_HOST_STALE_MS = 10 * 60 * 1000;
var SAME_HOST_PRESENCE_STALE_MS = 30 * 60 * 1000;
var LOCK_TIMEOUT_MS = 5000;
var MAX_RECENT_TARGETS = 8;
var lockWait2 = new Int32Array(new SharedArrayBuffer(4));
function currentHostTag() {
  return `${process.platform}:${hostname()}`;
}
function processStartIdentity2(pid) {
  try {
    const raw = readFileSync4(`/proc/${pid}/stat`, "utf-8").trim();
    const closeParen = raw.lastIndexOf(")");
    if (closeParen === -1)
      return null;
    const rest = raw.slice(closeParen + 2).split(" ");
    return rest[19] ? `linux-start:${rest[19]}` : null;
  } catch {
    return null;
  }
}
function ownerIsProvablyDead2(pid, processStart, hostTag, updatedAt) {
  if (!Number.isInteger(pid) || pid <= 0)
    return true;
  if (hostTag && hostTag !== currentHostTag()) {
    if (typeof updatedAt === "number" && Date.now() - updatedAt > CROSS_HOST_STALE_MS) {
      return true;
    }
    return false;
  }
  try {
    process.kill(pid, 0);
  } catch (error) {
    return error?.code === "ESRCH";
  }
  if (processStart?.startsWith("linux-start:")) {
    const current = processStartIdentity2(pid);
    return current !== null && current !== processStart;
  }
  return false;
}
function ensureDir2(dir) {
  if (!existsSync5(dir))
    mkdirSync4(dir, { recursive: true });
}
function sha256Short(value, len = 10) {
  return createHash2("sha256").update(value, "utf-8").digest("hex").slice(0, len);
}
function oneLine(value, maxChars = 220) {
  const flat = String(value ?? "").replace(/\s+/g, " ").trim();
  if (flat.length <= maxChars)
    return flat;
  return `${flat.slice(0, Math.max(0, maxChars - 1))}…`;
}
function safeFileKey(raw) {
  const cleaned = String(raw ?? "").trim().replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 64);
  const hash = sha256Short(String(raw ?? ""), 8);
  return `${cleaned || "item"}-${hash}`;
}
function assertFieldId(fieldId) {
  if (typeof fieldId !== "string" || fieldId.length === 0 || /[\\/\0]/.test(fieldId) || fieldId === "." || fieldId === ".." || fieldId.startsWith(".")) {
    throw new Error("Field ID must be a non-empty single path segment without slashes or leading dot");
  }
}
function resolveFieldStorageRoot(overrideRoot) {
  const root = overrideRoot?.trim() || process.env.PI_FIELD_ROOT?.trim() || getStorageRoot();
  ensureDir2(root);
  return root;
}
function fieldsDir(storageRoot) {
  const dir = join6(resolveFieldStorageRoot(storageRoot), "fields");
  ensureDir2(dir);
  return dir;
}
function fieldDir(fieldId, storageRoot) {
  assertFieldId(fieldId);
  return join6(fieldsDir(storageRoot), fieldId);
}
function metaPath(fieldId, storageRoot) {
  return join6(fieldDir(fieldId, storageRoot), "meta.json");
}
function pulsesPath(fieldId, storageRoot) {
  return join6(fieldDir(fieldId, storageRoot), "pulses.jsonl");
}
function presenceDir(fieldId, storageRoot) {
  return join6(fieldDir(fieldId, storageRoot), "presence");
}
function resourcesDir(fieldId, storageRoot) {
  return join6(fieldDir(fieldId, storageRoot), "resources");
}
function artifactsDir(fieldId, storageRoot) {
  const dir = join6(fieldDir(fieldId, storageRoot), "artifacts");
  ensureDir2(dir);
  return dir;
}
function atomicWrite2(target, content) {
  ensureDir2(resolve2(target, ".."));
  const temp = `${target}.tmp.${process.pid}.${randomUUID2()}`;
  try {
    writeFileSync3(temp, content, { encoding: "utf-8", flag: "wx" });
    for (let attempt = 0;attempt < 4; attempt += 1) {
      try {
        renameSync3(temp, target);
        return;
      } catch (err) {
        if ((err?.code === "EPERM" || err?.code === "EBUSY") && attempt < 3) {
          Atomics.wait(lockWait2, 0, 0, 10 * (attempt + 1));
          continue;
        }
        throw err;
      }
    }
  } finally {
    if (existsSync5(temp)) {
      try {
        unlinkSync3(temp);
      } catch {}
    }
  }
}
function readJsonSafe(path) {
  try {
    return JSON.parse(readFileSync4(path, "utf-8"));
  } catch {
    return null;
  }
}
function withFileLock(targetPath, fn, timeoutMs = LOCK_TIMEOUT_MS) {
  const lockPath = `${targetPath}.lock`;
  ensureDir2(resolve2(lockPath, ".."));
  const start = Date.now();
  const hostTag = currentHostTag();
  const selfStart = processStartIdentity2(process.pid);
  while (true) {
    const token = randomUUID2();
    const record = {
      version: 1,
      pid: process.pid,
      processStart: selfStart,
      hostTag,
      token,
      acquiredAt: Date.now()
    };
    const candidate = `${lockPath}.cand.${process.pid}.${token}`;
    let acquired = false;
    try {
      writeFileSync3(candidate, JSON.stringify(record), { encoding: "utf-8", flag: "wx", mode: 384 });
      try {
        linkSync2(candidate, lockPath);
        acquired = true;
      } catch (error) {
        if (error?.code !== "EEXIST")
          throw error;
      }
    } finally {
      if (existsSync5(candidate)) {
        try {
          unlinkSync3(candidate);
        } catch {}
      }
    }
    if (acquired) {
      try {
        return fn();
      } finally {
        const current = readJsonSafe(lockPath);
        if (current?.token === token) {
          try {
            unlinkSync3(lockPath);
          } catch {}
        }
      }
    }
    const held = readJsonSafe(lockPath);
    if (held && ownerIsProvablyDead2(held.pid, held.processStart, held.hostTag, held.acquiredAt)) {
      const check = readJsonSafe(lockPath);
      if (check?.token === held.token) {
        try {
          unlinkSync3(lockPath);
        } catch {}
      }
      continue;
    }
    if (Date.now() - start >= timeoutMs) {
      throw new Error(`Timed out waiting for field lock: ${lockPath}`);
    }
    Atomics.wait(lockWait2, 0, 0, 15);
  }
}
function openField(fieldId, goal, options = {}) {
  assertFieldId(fieldId);
  const trimmedGoal = String(goal ?? "").trim();
  if (!trimmedGoal)
    throw new Error("Field requires a non-empty goal");
  const dir = fieldDir(fieldId, options.storageRoot);
  ensureDir2(dir);
  ensureDir2(presenceDir(fieldId, options.storageRoot));
  ensureDir2(resourcesDir(fieldId, options.storageRoot));
  ensureDir2(artifactsDir(fieldId, options.storageRoot));
  const mPath = metaPath(fieldId, options.storageRoot);
  return withFileLock(mPath, () => {
    const existing = readJsonSafe(mPath);
    if (existing)
      return existing;
    const meta = {
      version: 1,
      id: fieldId,
      goal: trimmedGoal,
      ...options.topic ? { topic: options.topic } : {},
      mode: options.mode === "worktree" ? "worktree" : "shared",
      status: "active",
      rootCwd: options.rootCwd ?? process.cwd(),
      ...options.createdBy ? { createdBy: options.createdBy } : {},
      createdAt: Date.now()
    };
    atomicWrite2(mPath, JSON.stringify(meta, null, 2) + `
`);
    return meta;
  });
}
function getFieldMeta(fieldId, storageRoot) {
  try {
    assertFieldId(fieldId);
  } catch {
    return null;
  }
  return readJsonSafe(metaPath(fieldId, storageRoot));
}
function listFields(storageRoot) {
  const dir = fieldsDir(storageRoot);
  if (!existsSync5(dir))
    return [];
  const results = [];
  for (const entry of readdirSync2(dir)) {
    const meta = readJsonSafe(join6(dir, entry, "meta.json"));
    if (meta && meta.id === entry)
      results.push(meta);
  }
  return results.sort((a, b) => b.createdAt - a.createdAt);
}
function closeField(fieldId, options = {}) {
  assertFieldId(fieldId);
  const mPath = metaPath(fieldId, options.storageRoot);
  if (!existsSync5(mPath))
    return null;
  return withFileLock(mPath, () => {
    const current = readJsonSafe(mPath);
    if (!current)
      return null;
    const updated = {
      ...current,
      status: options.status ?? "closed",
      closedAt: Date.now()
    };
    atomicWrite2(mPath, JSON.stringify(updated, null, 2) + `
`);
    return updated;
  });
}
function mergeTargets(existing, incoming) {
  const merged = [];
  const seen = new Set;
  for (const item of [...incoming, ...existing]) {
    const clean = String(item ?? "").trim();
    if (!clean || seen.has(clean))
      continue;
    seen.add(clean);
    merged.push(clean);
    if (merged.length >= MAX_RECENT_TARGETS)
      break;
  }
  return merged;
}
function updatePresence(fieldId, update, storageRoot) {
  assertFieldId(fieldId);
  const dir = presenceDir(fieldId, storageRoot);
  ensureDir2(dir);
  const file = join6(dir, `${safeFileKey(update.actorId)}.json`);
  const prev = readJsonSafe(file);
  const focusArea = update.focusArea ?? prev?.focusArea;
  const next = {
    actorId: update.actorId,
    label: update.label ?? prev?.label ?? update.actorId,
    ...update.lens ?? prev?.lens ? { lens: update.lens ?? prev?.lens } : {},
    pid: process.pid,
    processStart: processStartIdentity2(process.pid),
    hostTag: currentHostTag(),
    cwd: update.cwd ?? prev?.cwd ?? process.cwd(),
    heading: oneLine(update.heading ?? prev?.heading ?? "exploring", 160),
    ...focusArea ? { focusArea } : {},
    recentTargets: mergeTargets(prev?.recentTargets ?? [], update.targets ?? []),
    stepCount: (prev?.stepCount ?? 0) + (update.incrementStep ? 1 : 0),
    ...update.lastTool ?? prev?.lastTool ? { lastTool: update.lastTool ?? prev?.lastTool } : {},
    ...update.lastToolError !== undefined ? { lastToolError: update.lastToolError } : prev?.lastToolError !== undefined ? { lastToolError: prev.lastToolError } : {},
    updatedAt: Date.now(),
    status: update.status ?? "active"
  };
  atomicWrite2(file, JSON.stringify(next) + `
`);
  return next;
}
function latestFieldActivityMs(fieldId, actorId, storageRoot) {
  let latest = 0;
  const probe = (path) => {
    try {
      const mtime = statSync(path).mtimeMs;
      if (mtime > latest)
        latest = mtime;
    } catch {}
  };
  try {
    assertFieldId(fieldId);
    if (actorId) {
      probe(join6(presenceDir(fieldId, storageRoot), `${safeFileKey(actorId)}.json`));
    }
    probe(pulsesPath(fieldId, storageRoot));
  } catch {}
  return latest;
}
function markPresenceDone(fieldId, actorId, status = "done", storageRoot) {
  try {
    assertFieldId(fieldId);
    const file = join6(presenceDir(fieldId, storageRoot), `${safeFileKey(actorId)}.json`);
    const prev = readJsonSafe(file);
    if (!prev)
      return;
    atomicWrite2(file, JSON.stringify({ ...prev, status, updatedAt: Date.now() }) + `
`);
  } catch {}
}
function listPresences(fieldId, options = {}) {
  assertFieldId(fieldId);
  const dir = presenceDir(fieldId, options.storageRoot);
  if (!existsSync5(dir))
    return [];
  const out = [];
  const now = Date.now();
  for (const name of readdirSync2(dir)) {
    if (!name.endsWith(".json"))
      continue;
    const item = readJsonSafe(join6(dir, name));
    if (!item || typeof item.actorId !== "string")
      continue;
    const dead = ownerIsProvablyDead2(item.pid, item.processStart, item.hostTag, item.updatedAt);
    const stale = now - item.updatedAt > SAME_HOST_PRESENCE_STALE_MS;
    if (!options.includeInactive && (item.status !== "active" || dead || stale))
      continue;
    out.push(dead && item.status === "active" ? { ...item, status: "done" } : item);
  }
  return out.sort((a, b) => a.label.localeCompare(b.label));
}
function normalizeResourceName(raw) {
  const clean = String(raw ?? "").trim().toLowerCase().replace(/\s+/g, "-");
  if (!clean)
    throw new Error("Resource name must be non-empty");
  return clean;
}
function claimResource(fieldId, resource, holder, storageRoot) {
  assertFieldId(fieldId);
  const norm = normalizeResourceName(resource);
  const purpose = oneLine(holder.purpose || "exclusive access", 160);
  const dir = resourcesDir(fieldId, storageRoot);
  ensureDir2(dir);
  const file = join6(dir, `${safeFileKey(norm)}.json`);
  return withFileLock(file, () => {
    const existing = readJsonSafe(file);
    if (existing && existing.holderId !== holder.actorId && !ownerIsProvablyDead2(existing.pid, existing.processStart, existing.hostTag, existing.updatedAt)) {
      return { acquired: false, lease: existing };
    }
    const now = Date.now();
    const lease = {
      resource: norm,
      holderId: holder.actorId,
      holderLabel: holder.label ?? holder.actorId,
      pid: process.pid,
      processStart: processStartIdentity2(process.pid),
      hostTag: currentHostTag(),
      purpose,
      acquiredAt: existing?.holderId === holder.actorId ? existing.acquiredAt : now,
      updatedAt: now
    };
    atomicWrite2(file, JSON.stringify(lease) + `
`);
    return { acquired: true, lease };
  });
}
function releaseResource(fieldId, resource, actorId, storageRoot) {
  assertFieldId(fieldId);
  const norm = normalizeResourceName(resource);
  const file = join6(resourcesDir(fieldId, storageRoot), `${safeFileKey(norm)}.json`);
  if (!existsSync5(file))
    return false;
  return withFileLock(file, () => {
    const existing = readJsonSafe(file);
    if (!existing)
      return false;
    if (existing.holderId !== actorId && !ownerIsProvablyDead2(existing.pid, existing.processStart, existing.hostTag, existing.updatedAt)) {
      return false;
    }
    try {
      unlinkSync3(file);
      return true;
    } catch {
      return false;
    }
  });
}
function releaseAllResources(fieldId, actorId, storageRoot) {
  const released = [];
  try {
    assertFieldId(fieldId);
    const dir = resourcesDir(fieldId, storageRoot);
    if (!existsSync5(dir))
      return released;
    for (const name of readdirSync2(dir)) {
      if (!name.endsWith(".json"))
        continue;
      const item = readJsonSafe(join6(dir, name));
      if (item?.holderId === actorId) {
        if (releaseResource(fieldId, item.resource, actorId, storageRoot)) {
          released.push(item.resource);
        }
      }
    }
  } catch {}
  return released;
}
function listResources(fieldId, storageRoot) {
  assertFieldId(fieldId);
  const dir = resourcesDir(fieldId, storageRoot);
  if (!existsSync5(dir))
    return [];
  const active = [];
  for (const name of readdirSync2(dir)) {
    if (!name.endsWith(".json"))
      continue;
    const file = join6(dir, name);
    const item = readJsonSafe(file);
    if (!item || typeof item.resource !== "string")
      continue;
    if (ownerIsProvablyDead2(item.pid, item.processStart, item.hostTag, item.updatedAt)) {
      continue;
    }
    active.push(item);
  }
  return active.sort((a, b) => a.resource.localeCompare(b.resource));
}
function readPulses(fieldId, sinceSeq, storageRoot) {
  assertFieldId(fieldId);
  const path = pulsesPath(fieldId, storageRoot);
  if (!existsSync5(path))
    return [];
  const raw = readFileSync4(path, "utf-8");
  const pulses = [];
  for (const line of raw.split(`
`)) {
    const trimmed = line.trim();
    if (!trimmed)
      continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (Number.isInteger(parsed?.seq) && typeof parsed?.fact === "string") {
        pulses.push(parsed);
      }
    } catch {}
  }
  return sinceSeq === undefined ? pulses : pulses.filter((p) => p.seq > sinceSeq);
}
function postPulse(fieldId, input, storageRoot) {
  assertFieldId(fieldId);
  const fact = String(input.fact ?? "").trim();
  if (!fact)
    throw new Error("Pulse requires a non-empty objective fact");
  const kind = input.kind ?? "echo";
  if (!PULSE_KINDS.includes(kind)) {
    throw new Error(`Unknown pulse kind "${kind}" (expected: ${PULSE_KINDS.join(", ")})`);
  }
  const pPath = pulsesPath(fieldId, storageRoot);
  ensureDir2(resolve2(pPath, ".."));
  const pulse = withFileLock(pPath, () => {
    const existing = readPulses(fieldId, undefined, storageRoot);
    const seq = (existing.at(-1)?.seq ?? 0) + 1;
    const record = {
      seq,
      timestamp: Date.now(),
      actorId: input.actorId,
      actorLabel: input.actorLabel ?? input.actorId,
      ...input.lens ? { lens: input.lens } : {},
      kind,
      fact,
      ...input.anchor?.trim() ? { anchor: oneLine(input.anchor, 180) } : {},
      ...input.next?.trim() ? { next: oneLine(input.next, 180) } : {}
    };
    appendFileSync3(pPath, JSON.stringify(record) + `
`, "utf-8");
    return record;
  });
  if (kind === "breach") {
    const mPath = metaPath(fieldId, storageRoot);
    if (existsSync5(mPath)) {
      withFileLock(mPath, () => {
        const meta = readJsonSafe(mPath);
        if (!meta)
          return;
        atomicWrite2(mPath, JSON.stringify({
          ...meta,
          status: "breached",
          breachedAt: pulse.timestamp,
          breachedBy: pulse.actorLabel,
          breachSeq: pulse.seq
        }, null, 2) + `
`);
      });
    }
  }
  try {
    updatePresence(fieldId, {
      actorId: input.actorId,
      label: input.actorLabel,
      lens: input.lens,
      heading: input.next || input.anchor || oneLine(fact, 120),
      targets: input.anchor ? [input.anchor] : []
    }, storageRoot);
  } catch {}
  return pulse;
}
function listArtifacts(fieldId, storageRoot) {
  assertFieldId(fieldId);
  const dir = join6(fieldDir(fieldId, storageRoot), "artifacts");
  if (!existsSync5(dir))
    return [];
  const entries = [];
  for (const name of readdirSync2(dir).sort()) {
    try {
      const info = statSync(join6(dir, name));
      entries.push(info.isDirectory() ? `${name}/` : `${name} (${info.size}B)`);
    } catch {
      entries.push(name);
    }
  }
  return entries;
}
function normalizePathTarget(rawPath, rootCwd) {
  const clean = rawPath.trim();
  if (!clean)
    return "";
  try {
    const abs = resolve2(rootCwd, clean);
    const rel = relative2(resolve2(rootCwd), abs);
    if (rel && !rel.startsWith("..") && !rel.startsWith("/")) {
      return rel.replace(/\\/g, "/");
    }
  } catch {}
  return clean.length > 96 ? `…/${basename(clean)}` : clean;
}
function dirOfTarget(target) {
  const clean = target.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  if (!clean || clean === ".")
    return;
  const parent = dirname3(clean);
  if (parent && parent !== "." && parent !== "/")
    return parent;
  return;
}
function focusAreaFromTarget(target) {
  const clean = target.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  if (!clean || clean === ".")
    return;
  return dirOfTarget(clean) ?? clean;
}
function extractToolTrace(toolName, input = {}, rootCwd = process.cwd()) {
  const tool = String(toolName ?? "").toLowerCase();
  const rawPath = String(input.file_path ?? input.path ?? "").trim();
  const normalizedPath = rawPath ? normalizePathTarget(rawPath, rootCwd) : "";
  if (tool === "field") {
    const action = String(input.action ?? "pulse");
    const detail = oneLine(String(input.anchor ?? input.resource ?? input.fact ?? ""), 64);
    return {
      heading: detail ? `field:${action} ${detail}` : `field:${action}`,
      targets: []
    };
  }
  if (normalizedPath) {
    const query = oneLine(String(input.pattern ?? input.query ?? ""), 40);
    const heading = query ? `${tool} "${query}" in ${normalizedPath}` : `${tool} ${normalizedPath}`;
    return {
      heading,
      targets: [normalizedPath],
      focusArea: focusAreaFromTarget(normalizedPath)
    };
  }
  const command = oneLine(String(input.command ?? ""), 88);
  if (command) {
    const dirHit = /(?:^|\s)([a-zA-Z0-9._-]+\/[a-zA-Z0-9._/-]+)/.exec(command);
    const dirTarget = dirHit ? normalizePathTarget(dirHit[1], rootCwd) : "";
    const focusArea = dirTarget ? focusAreaFromTarget(dirTarget) : undefined;
    return {
      heading: `${tool}: ${command}`,
      targets: dirTarget ? [dirTarget] : [],
      ...focusArea ? { focusArea } : {}
    };
  }
  const query = oneLine(String(input.pattern ?? input.query ?? ""), 64);
  if (query) {
    return {
      heading: `${tool} "${query}"`,
      targets: [],
      focusArea: `q:${query.slice(0, 24)}`
    };
  }
  return { heading: tool, targets: [] };
}
function emptySidelineCursor() {
  return {
    lastPulseSeq: 0,
    lastResourcesSig: "",
    lastPeersSig: "",
    lastOverlapSig: "",
    seenBreachSeqs: []
  };
}
function formatAgeSec(ts, now = Date.now()) {
  const sec = Math.max(0, Math.round((now - ts) / 1000));
  if (sec < 60)
    return `${sec}s`;
  const min = Math.floor(sec / 60);
  return `${min}m${sec % 60}s`;
}
function formatPulseLine(pulse, options = {}) {
  const lensTag = pulse.lens ? `/${pulse.lens}` : "";
  const anchor = pulse.anchor ? ` (${pulse.anchor})` : "";
  const fact = options.full ? String(pulse.fact ?? "").replace(/\s+/g, " ").trim() : oneLine(pulse.fact, 360);
  const next = pulse.next ? ` -> next: ${options.full ? String(pulse.next).replace(/\s+/g, " ").trim() : oneLine(pulse.next, 180)}` : "";
  const kindTag = pulse.kind === "breach" ? "BREACH!" : pulse.kind;
  return `#${pulse.seq} [${pulse.actorLabel}${lensTag}|${kindTag}]${anchor} ${fact}${next}`;
}
function buildSidelineDelta(fieldId, selfActorId, cursor, options = {}) {
  assertFieldId(fieldId);
  const now = options.now ?? Date.now();
  const allPulses = readPulses(fieldId, undefined, options.storageRoot);
  const latestSeq = allPulses.at(-1)?.seq ?? cursor.lastPulseSeq;
  const newPulses = allPulses.filter((p) => p.seq > cursor.lastPulseSeq && p.actorId !== selfActorId);
  const unseenBreaches = allPulses.filter((p) => p.kind === "breach" && p.actorId !== selfActorId && !cursor.seenBreachSeqs.includes(p.seq));
  const livePeers = listPresences(fieldId, { storageRoot: options.storageRoot }).filter((p) => p.actorId !== selfActorId);
  const resources = listResources(fieldId, options.storageRoot);
  const currentTargetSet = new Set((options.currentTargets ?? []).filter((t) => t && t !== "."));
  const currentSubdirSet = new Set([...currentTargetSet].map((t) => dirOfTarget(t)).filter((d) => Boolean(d && d.includes("/"))));
  const overlaps = [];
  if (currentTargetSet.size > 0) {
    for (const peer of livePeers) {
      let matchedTarget;
      for (const target of peer.recentTargets) {
        if (currentTargetSet.has(target)) {
          matchedTarget = target;
          break;
        }
      }
      if (!matchedTarget && currentSubdirSet.size > 0) {
        const peerArea = (peer.focusArea ?? dirOfTarget(peer.recentTargets[0] ?? ""))?.replace(/\/+$/, "");
        if (peerArea && currentSubdirSet.has(peerArea)) {
          matchedTarget = peerArea;
        }
      }
      if (matchedTarget) {
        overlaps.push({
          peerId: peer.actorId,
          peerLabel: peer.label,
          peerLens: peer.lens,
          target: matchedTarget,
          ageSec: Math.max(0, Math.round((now - peer.updatedAt) / 1000))
        });
      }
    }
  }
  const resourcesSig = resources.map((r) => `${r.resource}=${r.holderId}:${r.purpose}`).join("|");
  const peersSig = livePeers.map((p) => `${p.actorId}:${(p.focusArea ?? focusAreaFromTarget(p.recentTargets[0] ?? "") ?? "").replace(/\/+$/, "")}`).join("|");
  const overlapSig = overlaps.map((o) => `${o.peerId}@${o.target}`).sort().join("|");
  const hasNewPulses = newPulses.length > 0;
  const hasBreach = unseenBreaches.length > 0;
  const resourcesChanged = resourcesSig !== cursor.lastResourcesSig;
  const overlapAppeared = overlapSig.length > 0 && overlapSig !== cursor.lastOverlapSig;
  const peersShifted = peersSig !== cursor.lastPeersSig && (livePeers.length > 0 || cursor.lastPeersSig !== "");
  if (!hasNewPulses && !hasBreach && !resourcesChanged && !overlapAppeared && !peersShifted) {
    return null;
  }
  const lines = [];
  const range = newPulses.length > 0 ? ` #${newPulses[0].seq}..#${newPulses.at(-1).seq}` : "";
  lines.push(`[FIELD Δ${range} | field=${fieldId}]`);
  if (hasBreach) {
    lines.push("BREACH WAVE — a peer verified a breakthrough (evaluate against the full goal):");
    for (const bp of unseenBreaches) {
      lines.push(`  >> ${formatPulseLine(bp)}`);
    }
  }
  if (livePeers.length > 0) {
    const summary = livePeers.map((p) => {
      const lens = p.lens ? `(${p.lens})` : "";
      return `${p.label}${lens}: ${oneLine(p.heading, 64)} [${formatAgeSec(p.updatedAt, now)}]`;
    }).join(" | ");
    lines.push(`LIVE: ${summary}`);
  }
  if (resources.length > 0) {
    const locks = resources.map((r) => `${r.resource} -> ${r.holderLabel} (${oneLine(r.purpose, 48)})`).join(" | ");
    lines.push(`LOCK: ${locks}`);
  }
  if (overlaps.length > 0) {
    for (const o of overlaps) {
      const lens = o.peerLens ? ` (${o.peerLens})` : "";
      lines.push(`OVERLAP: ${o.peerLabel}${lens} also touched ${o.target} (${o.ageSec}s ago) — use an orthogonal angle if high-traction, or pivot to fresh surface.`);
    }
  }
  const nonBreachNew = newPulses.filter((p) => !unseenBreaches.some((b) => b.seq === p.seq));
  for (const p of nonBreachNew) {
    lines.push(formatPulseLine(p));
  }
  const nextCursor = {
    lastPulseSeq: latestSeq,
    lastResourcesSig: resourcesSig,
    lastPeersSig: peersSig,
    lastOverlapSig: overlapSig,
    seenBreachSeqs: [
      ...new Set([...cursor.seenBreachSeqs, ...unseenBreaches.map((b) => b.seq)])
    ]
  };
  return {
    text: lines.join(`
`),
    nextCursor,
    newPulses,
    hasBreach,
    breachPulses: unseenBreaches,
    livePeers,
    resources,
    overlaps
  };
}
function buildFieldSnapshot(fieldId, options = {}) {
  const meta = getFieldMeta(fieldId, options.storageRoot);
  if (!meta)
    return `[FIELD ${fieldId}: not found]`;
  const now = Date.now();
  const presences = listPresences(fieldId, { storageRoot: options.storageRoot });
  const resources = listResources(fieldId, options.storageRoot);
  const pulses = readPulses(fieldId, undefined, options.storageRoot);
  const artifacts = listArtifacts(fieldId, options.storageRoot);
  const maxPulses = options.maxRecentPulses ?? 20;
  const shown = pulses.slice(-maxPulses);
  const omitted = pulses.length - shown.length;
  const lines = [
    `[FIELD SNAPSHOT | id=${meta.id} | status=${meta.status} | mode=${meta.mode}]`,
    `GOAL: ${meta.goal}`,
    `ARTIFACTS DIR: ${artifactsDir(fieldId, options.storageRoot)}`
  ];
  if (presences.length > 0) {
    lines.push(`LIVE (${presences.length}): ` + presences.map((p) => {
      const self = p.actorId === options.selfActorId ? "*" : "";
      const lens = p.lens ? `(${p.lens})` : "";
      return `${self}${p.label}${lens}: ${oneLine(p.heading, 64)} [${formatAgeSec(p.updatedAt, now)}]`;
    }).join(" | "));
  } else {
    lines.push("LIVE: none");
  }
  if (resources.length > 0) {
    lines.push("LOCKS: " + resources.map((r) => `${r.resource} -> ${r.holderLabel} (${r.purpose})`).join(" | "));
  }
  if (artifacts.length > 0) {
    lines.push(`ARTIFACTS: ${artifacts.join(", ")}`);
  }
  if (shown.length > 0) {
    lines.push(`PULSES (${omitted > 0 ? `latest ${shown.length} of ${pulses.length}` : pulses.length}):`);
    for (const p of shown)
      lines.push(`  ${formatPulseLine(p)}`);
  } else {
    lines.push("PULSES: none yet");
  }
  return lines.join(`
`);
}
function buildCollectiveBoardSummary(fieldId, outcomes, storageRoot) {
  const meta = getFieldMeta(fieldId, storageRoot);
  const pulses = readPulses(fieldId, undefined, storageRoot);
  const artifacts = listArtifacts(fieldId, storageRoot);
  const byKind = (kind) => pulses.filter((p) => p.kind === kind);
  const breaches = byKind("breach");
  const conflicts = byKind("conflict");
  const artifactPulses = byKind("artifact");
  const echoes = byKind("echo");
  const needs = byKind("need");
  const statusDisplay = meta?.breachSeq ? `breached (#${meta.breachSeq} by ${meta.breachedBy ?? "peer"})` : meta?.status ?? "closed";
  const lines = [
    `## Live Flux Field: ${fieldId}`,
    `- **Goal**: ${meta?.goal ?? "(unknown)"}`,
    `- **Mode**: ${meta?.mode ?? "shared"} | **Status**: ${statusDisplay} | **Tentacles**: ${outcomes.length} | **Pulses**: ${pulses.length}`
  ];
  if (breaches.length > 0) {
    lines.push("", "### Breakthroughs (Verified Environment Hits)");
    for (const p of breaches)
      lines.push(`- ${formatPulseLine(p, { full: true })}`);
  }
  if (conflicts.length > 0) {
    lines.push("", "### Factual Conflicts (High-Gain Tension)");
    for (const p of conflicts)
      lines.push(`- ${formatPulseLine(p, { full: true })}`);
  }
  if (artifactPulses.length > 0 || artifacts.length > 0) {
    lines.push("", `### Shared Artifacts (\`${artifactsDir(fieldId, storageRoot)}\`)`);
    for (const p of artifactPulses)
      lines.push(`- ${formatPulseLine(p, { full: true })}`);
    if (artifacts.length > 0)
      lines.push(`- Files on disk: ${artifacts.join(", ")}`);
  }
  if (echoes.length > 0) {
    lines.push("", "### Objective Echoes (Lens × Observation)");
    for (const p of echoes)
      lines.push(`- ${formatPulseLine(p, { full: true })}`);
  }
  if (needs.length > 0) {
    lines.push("", "### Open Needs / Follow-up Probes");
    for (const p of needs)
      lines.push(`- ${formatPulseLine(p, { full: true })}`);
  }
  lines.push("", "### Tentacle Summaries");
  for (const o of outcomes) {
    const status = o.timedOut ? "TIMED OUT" : `exit ${o.exitCode}`;
    const metaTag = [o.lens, o.model].filter(Boolean).join(", ");
    const wt = o.worktreeDiffStat ? `
  - Worktree changes (${o.worktreePath}): ${oneLine(o.worktreeDiffStat, 240)}` : "";
    const excerpt = o.output.trim() || "(no final stdout)";
    lines.push(`- **${o.label}** [${metaTag || "default"}] (${status})${wt}
${excerpt}`);
  }
  return lines.join(`
`);
}
// core/field/worktree.ts
import { execFileSync } from "node:child_process";
import { existsSync as existsSync6, mkdirSync as mkdirSync5, rmSync } from "node:fs";
import { join as join7 } from "node:path";
function isGitRepository(cwd) {
  try {
    const out = execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
    return out === "true";
  } catch {
    return false;
  }
}
function createTentacleWorktree(repoCwd, fieldId, label, storageRoot) {
  assertFieldId(fieldId);
  if (!isGitRepository(repoCwd)) {
    throw new Error(`Worktree mode requires a git repository (cwd: ${repoCwd})`);
  }
  const safeLabel = label.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "tentacle";
  const baseDir = join7(resolveFieldStorageRoot(storageRoot), "worktrees", fieldId);
  mkdirSync5(baseDir, { recursive: true });
  const wtPath = join7(baseDir, safeLabel);
  const branch = `flux/${fieldId.slice(0, 32)}/${safeLabel}`;
  execFileSync("git", ["worktree", "add", "--detach", wtPath, "HEAD"], {
    cwd: repoCwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  return { label: safeLabel, path: wtPath, branch };
}
function inspectWorktreeChanges(wtPath) {
  try {
    const status = execFileSync("git", ["status", "--short"], {
      cwd: wtPath,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
    if (!status)
      return { dirty: false, summary: "" };
    const diffStat = execFileSync("git", ["diff", "--stat"], {
      cwd: wtPath,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
    const files = status.split(`
`).map((l) => l.trim()).join("; ");
    return {
      dirty: true,
      summary: diffStat ? `${files} | ${diffStat.split(`
`).at(-1)?.trim() ?? ""}` : files
    };
  } catch {
    return { dirty: false, summary: "" };
  }
}
function removeTentacleWorktree(repoCwd, wtPath) {
  try {
    execFileSync("git", ["worktree", "remove", "--force", wtPath], {
      cwd: repoCwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"]
    });
  } catch {
    if (existsSync6(wtPath)) {
      try {
        rmSync(wtPath, { recursive: true, force: true });
      } catch {}
    }
    try {
      execFileSync("git", ["worktree", "prune"], {
        cwd: repoCwd,
        stdio: ["ignore", "ignore", "ignore"]
      });
    } catch {}
  }
}
// core/flux/index.ts
import { existsSync as existsSync7, mkdirSync as mkdirSync6, readFileSync as readFileSync5, renameSync as renameSync4, unlinkSync as unlinkSync4, writeFileSync as writeFileSync4 } from "node:fs";
import { homedir as homedir2 } from "node:os";
import { dirname as dirname4, join as join8 } from "node:path";
var COGNITIVE_LENSES = [
  {
    id: "spine",
    name: "Spine Trace",
    startingBias: "Follow the most direct entry point, main execution path, or primary error chain straight inward to expose the core mechanism."
  },
  {
    id: "seam",
    name: "Seam Walker",
    startingBias: "Bypass thick front walls; inspect boundaries, configs, handoffs, fallback/error branches, and cross-module seams where bypasses hide."
  },
  {
    id: "probe",
    name: "Empirical Probe",
    startingBias: "Minimize static speculation; run small discriminating inputs, scripts, tests, or dynamic checks early to force concrete world feedback."
  },
  {
    id: "invert",
    name: "Falsifier",
    startingBias: "Target the most plausible-looking assumption or early consensus; look for counterexamples, boundary failures, and hidden false negatives."
  },
  {
    id: "scout",
    name: "Context Scout",
    startingBias: "Step back to map surrounding dependencies, environment constraints, history/knowledge entries, and cross-cutting invariants."
  }
];
function resolveLens(spec) {
  const clean = String(spec ?? "").trim();
  const lower = clean.toLowerCase();
  const builtin = COGNITIVE_LENSES.find((lens) => lens.id === lower || lens.name.toLowerCase() === lower);
  if (builtin)
    return builtin;
  return {
    id: lower.replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24) || "custom",
    name: clean || "Custom Lens",
    startingBias: clean || COGNITIVE_LENSES[0].startingBias
  };
}
function pickStartingLenses(count, requested) {
  const n = Math.max(1, Math.floor(count));
  const out = [];
  for (let i = 0;i < n; i += 1) {
    if (requested && requested[i]?.trim()) {
      out.push(resolveLens(requested[i]));
    } else {
      out.push(COGNITIVE_LENSES[i % COGNITIVE_LENSES.length]);
    }
  }
  return out;
}
var FLUX_FILE = "flux.json";
function getGlobalFluxPath(options = {}) {
  const home = options.globalHome?.trim() || process.env.HOME?.trim() || homedir2();
  return join8(home, ".pi-harness", FLUX_FILE);
}
function getProjectFluxPath() {
  return join8(getStorageRoot(), FLUX_FILE);
}
function hasProjectFluxConfig() {
  return existsSync7(getProjectFluxPath());
}
function cleanModels(models) {
  if (!Array.isArray(models))
    return [];
  const seen = new Set;
  const out = [];
  for (const item of models) {
    const trimmed = String(item ?? "").trim();
    if (!trimmed || seen.has(trimmed))
      continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}
function readConfigFile(path, source) {
  if (!existsSync7(path))
    return null;
  try {
    const raw = JSON.parse(readFileSync5(path, "utf-8"));
    if (!raw || typeof raw !== "object")
      return null;
    const mode = raw.mode === "worktree" || raw.mode === "shared" ? raw.mode : undefined;
    const tentacles = typeof raw.tentacles === "number" && Number.isInteger(raw.tentacles) && raw.tentacles >= 1 && raw.tentacles <= 8 ? raw.tentacles : undefined;
    return {
      enabled: raw.enabled !== false,
      models: cleanModels(raw.models),
      ...tentacles !== undefined ? { tentacles } : {},
      ...mode ? { mode } : {},
      configured: true,
      source
    };
  } catch {
    return null;
  }
}
function getFluxConfig(options = {}) {
  const project = readConfigFile(getProjectFluxPath(), "project");
  if (project)
    return project;
  const globalCfg = readConfigFile(getGlobalFluxPath(options), "global");
  if (globalCfg)
    return globalCfg;
  return { enabled: true, models: [], configured: false, source: "default" };
}
function isFluxDisabled(config) {
  return config.configured === true && config.enabled === false;
}
function setFluxConfig(config, scope = "project", options = {}) {
  const path = scope === "global" ? getGlobalFluxPath(options) : getProjectFluxPath();
  mkdirSync6(dirname4(path), { recursive: true });
  const persisted = {
    enabled: config.enabled !== false,
    models: cleanModels(config.models),
    ...config.tentacles !== undefined ? { tentacles: config.tentacles } : {},
    ...config.mode ? { mode: config.mode } : {}
  };
  const tmpPath = `${path}.${process.pid}.tmp`;
  writeFileSync4(tmpPath, JSON.stringify(persisted, null, 2) + `
`, "utf-8");
  renameSync4(tmpPath, path);
}
function clearProjectFluxConfig() {
  const path = getProjectFluxPath();
  if (!existsSync7(path))
    return false;
  try {
    unlinkSync4(path);
    return true;
  } catch {
    return false;
  }
}
function resolveFluxModels(config, currentModelSpec, overrideModels) {
  const override = cleanModels(overrideModels);
  if (override.length > 0)
    return override;
  const configured = cleanModels(config.models);
  if (configured.length > 0)
    return configured;
  const active = String(currentModelSpec ?? "").trim();
  if (active)
    return [active];
  return [];
}
// core/identity/index.ts
var __dirname = ".";
var DEBATE_DISCIPLINE = `
DEBATE DISCIPLINE (strict):
1. EVIDENCE-BASED: Every claim MUST cite specific evidence (code, docs, data, logic). Unsupported assertions are invalid.
2. RESPOND TO EVIDENCE: Read the board before posting. If other participants have already posted, your response MUST directly address their specific arguments.
3. NO DRIFT: Do not be persuaded by rhetoric or authority. Only change your position if presented with evidence that logically disproves your current stance. State explicitly what changed your mind.
4. REFLECT: Before your final post, explicitly state: "What is the strongest point my opponent made that I cannot refute?" If nothing — explain why.
5. STEEL-MAN: Before attacking an opposing view, restate it in its strongest possible form. Attack the strong version, not a straw man.
`.trim();
var FLUX_DISCIPLINE = `
COLLECTIVE INTELLIGENCE DISCIPLINE (Live Flux):
1. DRIVE BY WORLD FEEDBACK: Keep probing the real environment until you reach a verified breakthrough, genuine saturation across angles, or a concrete external block. Never stop early just to deliver a progress report.
2. INITIAL LENS, NOT A CAGE: Your starting lens breaks initial symmetry. Follow stronger live gradients (your own or peers' in [FIELD Δ]) whenever environment feedback justifies pivoting.
3. OBJECTIVE ECHOES ONLY: Emit \`field action=pulse\` (method -> observed echo -> next heading) on decision-changing feedback. Never output confidence scores, never grade peers, and never declare a target unconditionally dead — name the method tested so other angles remain open.
4. COHERENT OVERLAP & EXCLUSIVE RESOURCES: Avoid repeating the exact same check a peer just ran; use orthogonal angles on high-traction leads or factual conflicts. Coordinate exclusive mutable targets via \`field action=claim\` / \`release\`, and share reusable outputs in the field artifacts dir (\`kind=artifact\`).
5. CONVERGE ON BREACH: Emit \`field action=pulse kind=breach\` immediately on a verified breakthrough. When a peer emits \`breach\`, evaluate it against the full goal — independently verify, close remaining gaps, or finish cleanly.
`.trim();
export {
  COGNITIVE_LENSES,
  FLUX_DISCIPLINE,
  PULSE_KINDS,
  addEntry,
  appendEvent,
  artifactsDir,
  assessCloseReadiness,
  auditIndex,
  buildCollectiveBoardSummary,
  buildFieldSnapshot,
  buildSidelineDelta,
  claimResource,
  clearProjectFluxConfig,
  closeField,
  closeTopic,
  createTentacleWorktree,
  emptySidelineCursor,
  extractToolTrace,
  getEntry,
  getFieldMeta,
  getFluxConfig,
  getGlobalFluxPath,
  getIndex,
  getKnowledgeRoot,
  getProjectFluxPath,
  getProjectRoot,
  getTopicCatalogEntry,
  getWorkspaceRoot,
  hasArchivedTopic,
  hasProjectFluxConfig,
  inspectWorktreeChanges,
  isFluxDisabled,
  isGitRepository,
  latestFieldActivityMs,
  listArtifacts,
  listFields,
  listOpenTopicCatalog,
  listOpenTopics,
  listPresences,
  listResources,
  listTopicCatalog,
  listTopics,
  markConflict,
  markPresenceDone,
  openField,
  openTopic,
  pickStartingLenses,
  postNote,
  postPulse,
  readArchivedTopic,
  readNotes,
  readPulses,
  releaseAllResources,
  releaseResource,
  removeTentacleWorktree,
  resolveFieldStorageRoot,
  resolveFluxModels,
  resolveLens,
  runWithProjectRoot,
  scopedProjectRoot,
  setFluxConfig,
  updatePresence
};
