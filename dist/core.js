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
export {
  addEntry,
  appendEvent,
  assessCloseReadiness,
  auditIndex,
  closeTopic,
  getEntry,
  getIndex,
  getKnowledgeRoot,
  getProjectRoot,
  getTopicCatalogEntry,
  getWorkspaceRoot,
  hasArchivedTopic,
  listOpenTopicCatalog,
  listOpenTopics,
  listTopicCatalog,
  listTopics,
  markConflict,
  openTopic,
  postNote,
  readArchivedTopic,
  readNotes,
  runWithProjectRoot,
  scopedProjectRoot
};
