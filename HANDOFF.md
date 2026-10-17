# HANDOFF — set this up on another machine

**Goal:** a new machine (Windows host + WSL distro) gets the same working setup:
DSH with the pi-harness bridge, the personal skills, and the WSL/IDA tool bridge.

Everything below is idempotent; nothing here touches the `pi-harness` repository
except the optional core patch described in §4.

---

## 1. Install DSH and the plugin

1. Install DeepSeek Harness (Desktop). Confirm `plugin_manager` is available:
   ask the agent to `list_plugins`, or open Plugin Manager.
2. Clone this repository somewhere stable — **not** inside a temporary workspace:

   ```bash
   git clone https://github.com/kings0527/dsh-pi-harness.git ~/git/dsh-pi-harness
   ```

3. Install the bundle:

   ```text
   plugin_manager install_bundle target="C:\Users\<you>\git\dsh-pi-harness"
   ```

4. The install result must say `application: applied`. Then verify:

   ```text
   handoff action=status
   ```

   You should see the project root, `board: N open / M archived`, and the three
   knowledge roots (project+workspace, global).

**The plugin is a linked directory.** If you move or delete the clone, DSH can no
longer load it. To relocate: `remove_bundle`, move the directory, `install_bundle`
again.

---

## 2. Point it at real projects

No migration. Open a session in any directory that already has `.pi-board/`,
`knowledge/` or `handoff/` — including projects created by `pi` in WSL. DSH can
work on them over UNC:

```
\\wsl.localhost\<Distro>\home\<user>\git\<project>
```

The first turn injects a checkpoint: knowledge catalog, open Board topics, latest
handoff. Slow file access over UNC is expected; small board/knowledge files are
fine.

---

## 3. Personal skills (optional, separate from the plugin)

The plugin ships no skills. To reproduce the author's skill set:

1. Copy skills into the DSH user root: `C:\Users\<you>\.dsh\skills\<name>\SKILL.md`.
   The filesystem skill provider discovers that root automatically — no config,
   no restart.
2. Flatten two-level layouts: `<root>/<name>/SKILL.md` only. A nested
   `mattpocock/tdd/SKILL.md` is invisible; copy it as `tdd/SKILL.md`.
3. Every skill needs `name:` and `description:` frontmatter. Missing `name` is a
   **silent** drop.
4. Remove Claude-Code-only keys: `allowed-tools`, `disable-model-invocation`
   (the latter is *honoured* by DSH and hides the skill from the model).

### Licence map for the personal set

| Source | Directories | Licence |
|---|---|---|
| pi-harness original | harness-meta + RE skills | MIT © kings0527 |
| Matt Pocock | `tdd`, `code-review`, `domain-modeling`, `prototype`, `research`, `diagnosing-bugs`, `implement`, `to-spec`, `writing-great-skills`, `resolving-merge-conflicts` | MIT (no upstream notice was bundled — add one before redistributing) |
| Trail of Bits | `dwarf-expert` | **CC BY-SA 4.0** — adaptations stay share-alike; do not relicense as MIT |
| yaklang/hack-skills | `anti-debugging-techniques`, `binary-protection-bypass`, `code-obfuscation-deobfuscation`, `symbolic-execution-tools`, `vm-and-bytecode-reverse` | MIT © VillanCh |

Keep licence text **outside** the scanned skill root (e.g.
`C:\Users\<you>\.dsh\pi-harness-skill-licenses\`), because a stray `.md` at the
root is parsed as a flat skill.

To park a skill without deleting it, move it to `skills\_disabled\<name>\` —
nested directories are not scanned.

---

## 4. Optional: share one core implementation with pi

Out of the box the plugin uses its bundled `dist/core.js`, so nothing else is
required. If you also maintain `pi-harness` and want one source of truth, apply
the root-scoping patch there:

- `core/runtime/root.ts` — `AsyncLocalStorage` + `runWithProjectRoot`
- `core/storage/index.ts` — scoped branch before the original memoized `cwd` path
- `core/knowledge/index.ts` — `resolve(scopedProjectRoot() ?? startDir)`
- `core/dsh.ts` — single re-export entry point used by the bundle

The default branch is byte-identical to the unpatched code (verified by comparing
normalized output digests of the same operations), so standalone `pi` behaviour
does not change. Rebuild afterwards:

```bash
bun build core/dsh.ts --outfile ../dsh-pi-harness/dist/core.js --format esm --target node
```

---

## 5. WSL tool bridge (IDA example)

DSH runs on Windows; IDA and `ida-pro-mcp` live in WSL. The bridge is a two-file
wrapper, not a plugin:

- `%USERPROFILE%\.dsh\skills\ida-mcp\bin\ida.cmd` → `wsl.exe ... python3 ida_bridge.py %*`
- `%USERPROFILE%\.dsh\skills\ida-mcp\scripts\ida_bridge.py` → translates
  `C:\…` → `/mnt/c/…` and `\\wsl.localhost\…` → `/…`, then execs `ida.py`

Verify:

```powershell
& "$env:USERPROFILE\.dsh\skills\ida-mcp\bin\ida.cmd" --status
```

A `localhost proxy` warning on stderr is WSL's, not an error. The managed daemon
persists across calls; `--stop` restarts it.

---

## 6. Verification checklist

| Check | Expected |
|---|---|
| `handoff action=status` | project root, board counts, three knowledge roots |
| `board action=list` in an existing project | the topics that already exist there |
| `board action=read topic=… limit=3` on a big topic | 3 notes + `[N earlier notes withheld … since=…]` |
| `knowledge action=read path=index.md limit=50` | header with byte/line counts, then 50 lines |
| `ida.cmd --status` | managed daemon + `IDA install : /home/…/ida-pro-*` |

---

## 7. Known limits

- No Board UI panel yet; the data is on disk, the panel is additive.
- `board` has no `participate` action — open-topic bodies are injected with a byte
  cap, `board action=read` gets the rest.
- `close` recovery is idempotent retry, not pi's three-phase close journal.
- The plugin never writes `.pi-board/context-snapshots/` (a pi audit artifact).
- Do not run `pi` and DSH writing the same topic concurrently.

## 8. State of the author's machine (for reference)

- Plugin: `%USERPROFILE%\git\dsh-pi-harness`, installed as a linked directory.
- Skills: `%USERPROFILE%\.dsh\skills` (28 skills, `find-skills` deliberately absent).
- IDA: WSL `Ubuntu-26.04`, IDA under `/home/<user>/tools/ida-pro-9.4`, `ida-pro-mcp` 2.0.0.
- Projects live in WSL; DSH reaches them over `\\wsl.localhost\…`.
