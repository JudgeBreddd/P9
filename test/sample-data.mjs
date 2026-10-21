/* Test-only sample data for the UI tests; it never ships (Tyler, 2026-10-20: "sample data should not be in the app at all").
   The desktop hands it to the page only unpackaged with P9_SAMPLE_DATA=1 (apps/desktop/main.mjs). Mirrors the real apps' shapes
   (ACP typed events, hub registry.json). */
export const M = (() => {
const now = new Date('2026-10-11T19:52:00');
const sessions = [
 { id:'s-claude-1', agent:'claude', title:'Refactor provider lease', model:'Opus 5.5', mode:'Manual', effort:'Medium', state:'running', pending:'approval', context:{used:118400,size:200000}, limits:{h5:0.31,d7:0.58}, cacheMin:14, cwd:'~/workspace/personal-projects/agent-first-workspace',
   events:[
    {t:'user', text:'The tab lease in provider-service.ts has a 60 s grace. Make the grace configurable from the bootstrap payload and keep the default at 60.', when:'19:31'},
    {t:'thought', text:'Need to find where the grace constant lives, who reads it, and whether the UI hardcodes the 60 s copy.'},
    {t:'tool', status:'completed', title:'Grep "60_000" in _engine', output:'_engine/provider-service.ts:48:const LEASE_GRACE_MS = 60_000;\n_engine/provider-service.ts:212:    setTimeout(() => this.expire(id), LEASE_GRACE_MS);\napp/chat-pane.tsx:591:  Closing this browser tab keeps the agent for 60 s, then stops it.'},
    {t:'tool', status:'completed', title:'Read _engine/provider-service.ts', output:'220 lines read.'},
    {t:'agent', text:'Two readers of the constant and one hardcoded copy string. I will thread leaseGraceMs through /api/bootstrap and read it in the pane footer.'},
    {t:'tool', status:'completed', title:'Edit _engine/provider-service.ts', diff:[['ctx','  constructor(opts: ProviderOptions) {'],['del','    const LEASE_GRACE_MS = 60_000;'],['add','    this.graceMs = opts.leaseGraceMs ?? 60_000;'],['ctx','    this.store = opts.store;'],['ctx','  }'],['ctx','  …'],['del','    setTimeout(() => this.expire(id), LEASE_GRACE_MS);'],['add','    setTimeout(() => this.expire(id), this.graceMs);']]},
    {t:'plan', entries:[['completed','Find every reader of the grace constant'],['completed','Make it an option on ProviderService'],['in_progress','Expose it on /api/bootstrap'],['pending','Read it in chat-pane footer copy'],['pending','Add a unit test for a 5 s grace']]},
    {t:'approval', title:'Edit _engine/server.ts', diff:[['ctx','  app.get("/api/bootstrap", (c) => c.json({'],['ctx','    compactWindow,'],['add','    leaseGraceMs: service.graceMs,'],['ctx','  }));']], options:[['allow_once','Allow once'],['allow_always','Always allow'],['reject','Deny']]},
   ]},
 { id:'s-codex-1', agent:'codex', title:'Unit tests for codex-limits', model:'gpt-5.1-codex', mode:'workspace-write', effort:'High', state:'running', pending:null, context:null, limits:{h5:0.05,d7:0.39}, cacheMin:null, cwd:'~/workspace/personal-projects/agent-first-workspace',
   events:[
    {t:'user', text:'Write tests for _engine/codex-limits.ts covering a renamed window key and an unreadable sessions dir.', when:'19:40'},
    {t:'tool', status:'completed', title:'Read _engine/codex-limits.ts', output:'96 lines read.'},
    {t:'tool', status:'in_progress', title:'Write _engine/codex-limits.test.ts', output:''},
    {t:'agent', text:'Writing three cases: canonical keys, primary_window renamed to windows[0], and a missing directory that must yield {} without throwing.'},
   ]},
 { id:'s-claude-2', agent:'claude', title:'Pick a colour', model:'Sonnet 5.5', mode:'Default', effort:'Low', state:'running', pending:'question', context:{used:21000,size:200000}, limits:{h5:0.31,d7:0.58}, cacheMin:52, cwd:'~/workspace/personal-projects/agent-first-workspace/protected/acp-probe-fixture',
   events:[
    {t:'user', text:'Use your AskUserQuestion tool to ask me one question: pick a colour, options red or blue. Then reply with the colour I picked.', when:'19:47'},
    {t:'question', title:'Pick a colour?', fields:[{kind:'radio', label:'Colour', options:['red','blue']},{kind:'text', label:'Why (optional)'}]},
   ]},
 { id:'s-codex-2', agent:'codex', title:'Probe fixture cleanup', model:'gpt-5.1-codex-mini', mode:'read-only', effort:'Low', state:'stopped', pending:null, context:null, limits:{h5:0.05,d7:0.39}, cacheMin:null, cwd:'~/workspace/personal-projects/agent-first-workspace',
   events:[
    {t:'user', text:'List the fixture files older than a week.', when:'18:02'},
    {t:'tool', status:'completed', title:'Shell: find protected/acp-probe-fixture -mtime +7', output:'protected/acp-probe-fixture/edit-20b7fac1.txt\nprotected/acp-probe-fixture/edit-3c1a9d2e.txt'},
    {t:'agent', text:'Two files. I have not deleted anything; say the word and I will move them to recommended-delete.'},
    {t:'notice', text:'Session stopped by Stop All at 18:40. Resume continues the native session.'},
   ]},
];
const history = [
 {id:'349a2c86', agent:'claude', title:'Phase 9 acceptance fixes', when:'Yesterday 22:14', events:412},
 {id:'b17e0d03', agent:'codex', title:'Windows os-process branch', when:'Yesterday 16:03', events:188},
 {id:'7f2c11aa', agent:'claude', title:'Context meter above composer', when:'Oct 9, 20:40', events:96},
 {id:'e02ab9c1', agent:'codex', title:'codex-limits reader', when:'Oct 9, 19:12', events:140},
];
const files = [
 {name:'_engine', kids:[{name:'acp-connection.ts'},{name:'codex-limits.ts'},{name:'os-process.ts'},{name:'provider-service.ts', mod:true},{name:'server.ts', mod:true},{name:'store.ts'}]},
 {name:'app', kids:[{name:'app.tsx'},{name:'chat-client.ts'},{name:'chat-model.ts'},{name:'chat-pane.tsx'},{name:'file-workspace.tsx'},{name:'globals.css'},{name:'terminal-pane.tsx'}]},
 {name:'_private', kids:[{name:'conversations.db'},{name:'phase-9', kids:[{name:'receipt.json'}]}]},
 {name:'contracts.md'},{name:'plan.md'},{name:'package.json'},{name:'start-local.sh'},
];
const fileBody = {
 // the 5 _tyler items, shaped like _templates/tyler-item.md (mock text)
 '_tyler/agent-first-workspace-phase-9-daily-driver.md':['# Is agent-first-workspace ready to be your daily driver?','','**Written:** 2026-10-12','**Do:** run the twelve steps below at the laptop (about 20 minutes), then answer "ready" or list what broke.','','1. Start it: bash start-local.sh, open http://127.0.0.1:5173','2. Open a Claude chat and a Codex chat side by side','3. Ask each for a one-file change; approve one, deny the other','4. Close the browser mid-turn, reopen: the turn is still there','5. Steps 5-12 cover files, terminal, History and Stop All','','**Who does the work:** you: a by-eye check at the keyboard.','**Why it didn\'t block:** phase 10 (Windows) was built in the meantime.','**Then I\'ll:** tick agent-first-workspace/plan.md phase 9, or fix what you list.','','**Your answer:** "ready", or a list of what broke.','A.'].join('\n'),
 '_tyler/agent-first-workspace-phase-10-windows-run.md':['# Run the Windows acceptance on desktop?','','**Written:** 2026-10-12','**Do:** on desktop, run: bash workspace/protected/run/desktop/afw-acceptance.sh (about 6 minutes), then paste the last line.','','**Who does the work:** you: it has to run on desktop, which agents cannot reach.','**Why it didn\'t block:** the laptop and server runs passed (44 of 45).','**Then I\'ll:** tick phase 10 and close windows-passdown row 23.','','**Your answer:** the last line it prints.','A.'].join('\n'),
 '_tyler/bookshelf-measure.md':['# What are the wall measurements above the lasers?','','**Written:** 2026-10-05','**Do:** measure three things with a tape (about 5 minutes):','','1. Wall width between the corner and the window frame','2. Height from the laser table top to the ceiling','3. Distance of each outlet from the left corner','','**Who does the work:** you: a physical measurement.','**Why it didn\'t block:** the build sheet uses 15 ft as a placeholder.','**Then I\'ll:** finish build-sheet.md cut list, bookshelf-expansion/plan.md phase 2.','','**Your answer:** three numbers in inches.','A.'].join('\n'),
 '_tyler/duwop-vendor-or-registry.md':['# Vendor DUWOP into design-suite, or install it from the team\'s registry?','','**Written:** 2026-10-11','**Do:** pick 1 or 2.','','**What\'s broken or missing today:** three projects copy duwop.css by hand and have drifted apart.','**Recommended:** 1, vendor it into design-suite/ with a version line.','**How it fixes it:** one copy, every project links to it; updates are a deliberate pull.','**Verified:** diffed the three copies: 41 lines differ, none on purpose.','**Conflicts with the rest of the system:** none found; design-suite already holds the tokens.','**Is the fix robust:** yes, it removes the copies instead of syncing them.','**If we do nothing:** the looks keep drifting.','**Other options:** 2, the registry: auto updates, but an outside change can restyle every app.','**Who does the work:** the agent, after your yes.','','**Your answer:** 1, 2, or "none of these".','A.'].join('\n'),
 '_tyler/va-phase-3-look.md':['# Do the ranked conditions match your real DD-214 MOS list?','','**Written:** 2026-10-01','**Do:** open the report (va-claims-assistant/out/ranked.md) next to your DD-214 and compare the MOS codes (about 10 minutes).','','**Who does the work:** you: only you have the DD-214.','**Why it didn\'t block:** the checklist and intake were built against sample data.','**Then I\'ll:** tick va-claims-assistant/plan.md phase 3, or fix the mapping.','','**Your answer:** "matches", or the codes that are wrong.','A.'].join('\n'),
 'provider-service.ts':['import { Store } from "./store";','import { AcpConnection } from "./acp-connection";','','export interface ProviderOptions {','  store: Store;','  leaseGraceMs?: number;','}','','export class ProviderService {','  graceMs: number;','  private store: Store;','  private leases = new Map<string, Lease>();','','  constructor(opts: ProviderOptions) {','    this.graceMs = opts.leaseGraceMs ?? 60_000;','    this.store = opts.store;','  }','','  claim(id: string, tab: string) {','    const lease = this.leases.get(id);','    if (lease && lease.tab !== tab && !lease.expired) throw new Error("owned by another tab");','    this.leases.set(id, { tab, expired: false });','  }','','  release(id: string) {','    const lease = this.leases.get(id);','    if (!lease) return;','    setTimeout(() => this.expire(id), this.graceMs);','  }','}'].join('\n'),
 'server.ts':['import { Hono } from "hono";','import { ProviderService } from "./provider-service";','','export function createApp(service: ProviderService, compactWindow: number) {','  const app = new Hono();','  app.get("/api/bootstrap", (c) => c.json({','    compactWindow,','  }));','  app.get("/api/conversations", (c) => c.json(service.list()));','  return app;','}'].join('\n'),
 'plan.md':['# Plan — agent-first-workspace','','## Phase 9 — live acceptance','- [x] real server, both adapters, 44/45','- [~] your daily-driver review (parked in _tyler/)','','## Phase 10 — Windows run','- [~] desktop run (windows-passdown row 23)'].join('\n'),
 'contracts.md':['# ACP contracts','','| package | version |','|---|---|','| @agentclientprotocol/sdk | 1.8.0 |','| claude-agent-acp | 0.88.0 |','| codex-acp | 2.1.1 |'].join('\n'),
};
const terminal = ['user@laptop agent-first-workspace % pnpm test','','> agent-first-workspace@0.1.0 test','> node --test --import tsx _engine/*.test.ts','','✔ provider-service lease grace (12ms)','✔ os-process terminates group (48ms)','✔ codex-limits renamed keys (3ms)','ℹ tests 51','ℹ pass 51','ℹ fail 0','','user@laptop agent-first-workspace % '];
const commands = ['New Codex session','New Claude session','Toggle chat split','Browse files','Toggle files pane','Toggle terminal','Stop all sessions','Switch theme'];

/* Mission Control */
const queue = [
 {proj:'agent-first-workspace', kind:'gate check', txt:'Phase 9 daily-driver review: twelve steps, about 20 minutes at the laptop.', file:'_tyler/agent-first-workspace-phase-9-daily-driver.md', age:'2 d'},
 {proj:'agent-first-workspace', kind:'command', txt:'Run the Windows acceptance on desktop (windows-passdown row 23).', file:'_tyler/agent-first-workspace-phase-10-windows-run.md', age:'2 d'},
 {proj:'bookshelf-expansion', kind:'measurement', txt:'Measure the wall above the lasers: width, height to ceiling, outlet positions.', file:'_tyler/bookshelf-measure.md', age:'9 d'},
 {proj:'icm-upgrades', kind:'decision', txt:'Vendor DUWOP into design-suite or install from the team\'s registry?', file:'_tyler/duwop-vendor-or-registry.md', age:'3 d'},
 {proj:'va-claims-assistant', kind:'look', txt:'Check the ranked conditions output against your real DD-214 MOS list.', file:'_tyler/va-phase-3-look.md', age:'13 d'},
];
const notifications = [
 {kind:'silent job', txt:'rss-report did not report in since Oct 9 02:00', level:'bad'},
 {kind:'setup', txt:'restic snapshot is 31 h old (threshold 24 h)', level:'warn'},
];
const inbox = [
 {batch:'librarian-2026-10-11-0210', pages:3, status:'pending', body:'# Wiki/Context/tab-lease.md\n\nA browser tab owns the chats it opens. Grace is 60 s after the tab closes.\n\n---\n# Wiki/Projects/agent-first-workspace.md\n\nPhase 9 passed on code; parked on your review.'},
 {batch:'librarian-2026-10-10-0210', pages:1, status:'merge', body:'# Wiki/Context/codex-limits.md\n\nCodex meters read from ~/.codex/sessions rollouts.'},
 {batch:'librarian-2026-10-09-0210', pages:2, status:'reject', body:'# Wiki/Context/old-pty.md\n\nSuperseded by ACP.'},
];
const audit = {run:'audit-2026-10-06', status:'pending', ticked:4, total:11, contradictions:2};
const logs = {host:'server', incidents:[{txt:'librarian run exited 1 at 02:10 (ENOSPC on /var)', level:'bad'},{txt:'resolved: commit.sh backlog cleared 14:00', level:'ok'}], rows:[['commit.sh','12 min ago','[14:30] 17 files committed by Syncthing delivery'],['librarian','17 h ago','ingest: 3 pages queued for review'],['heartbeats','1 h ago','9 jobs ok, 1 late (rss-report)'],['backup','31 h ago','snapshot 7f1e… 2.1 GB']]};
const stats = [['Work in flight (HANDOFF.md)',3],['Ideas not researched',14],['Punch-list items',7]];
const solo = {when:'Oct 10, 03:12', txt:'Worked 4 of 6 --solo items; 2 parked (needs a key).', report:'protected/solo-runs/2026-10-10.md'};
const apps = [
 ['Claude Code','Claude Code in the workspace, in a terminal.',true],['Claude chat','claude.ai as its own window.'],['VS Code','The desktop editor on ~/workspace.'],['VS Code server','Starts the browser VS Code (your settings, synced by Syncthing).'],['Chrome','A normal browser window.'],['Obsidian (LLM Wiki)','The Wiki vault in Obsidian.'],['T-Tracer','Logo → laser-ready SVG vectorizer.'],['Wave','The hub terminal (this app\'s home).'],['DIBBS Watch','Start the KPV RFQ board if needed and open it.'],['--solo run in VS Code','Opens Claude Code in VS Code with /icm-solo --solo typed.'],['Dev: personal dashboard','run.py from ~/.venvs/personal-dashboard.'],['Dev: Cart Pulse','python -m app.api in a terminal, then opens :5055.'],['Dev: family dashboard v2','run.py in a terminal, then opens :8080.'],['Dev: server rack screen','The 3U screen page with mock stats, then opens :8077.'],
];
const tools = [['Buy / don\'t buy','Money calc: is this purchase worth it?'],['Compound interest','Money calc: growth over time.'],['Car loan','Money calc: payment from price, or price from payment.'],['Qual Schedule Builder','Starts its local server in a terminal and opens it.']];
const pages = [['Personal dashboard','http://server:5000/'],['Business hub','http://server:5000/bus'],['Server radar','http://server:8077/'],['DIBBS Watch','http://127.0.0.1:8792/'],['Agent workspace','http://127.0.0.1:5173/']];
/* [id, name, desc, lastStatus, lastRun, duration, extra?] */
const scripts = {
 Health:[['continuity','Continuity check','Three machines, one workspace: is anything out of sync?','ok','2 h ago','4 s'],['doctor','Doctor','Every hook, script and link this machine needs, with the fix for each.','warn','2 h ago','9 s'],['heartbeats','Job heartbeats','Which scheduled jobs reported in, which went silent.','warn','1 h ago','1 s'],['maintenance','ICM maintenance (read-only)','What the maintenance checklist would change.','ok','1 d ago','21 s'],['watchdog-check','Watchdog check','Is the watchdog itself alive?','ok','2 h ago','1 s'],['guard-tests','Guard hook tests','Runs the delete-guard test suite.','ok','3 d ago','6 s'],['stop-tests','Stop-hook tests','Runs the Stop hook test suite.','ok','3 d ago','5 s'],['rollover-toggle','Rollover sensor on/off','Toggle the context-rollover sensor.','ok','5 d ago','0 s'],['context-usage','Context usage','How full is the current Claude session?','ok','10 min ago','1 s']],
 Skills:[['skills-check','Skills check','Compares ICM-skills.md with what is installed.','ok','1 d ago','2 s'],['skills-apply','Skills apply','Installs or removes skills to match the list.','ok','6 d ago','40 s',{args:['--dry-run'],confirm:true}],['skills-links','Skill links','Lists every symlink into agent_skills.','ok','1 d ago','1 s'],['skills-link-fix','Fix skill links','Repairs broken symlinks.','ok','9 d ago','2 s'],['skills-screen','Screen a skill','Reads a downloaded skill and reports risks.','ok','12 d ago','18 s'],['skills-release-restore','Restore skills release','Rolls back to the last tagged skill set.','ok','20 d ago','3 s'],['static-screen','Static screen','Static checks on a skill folder.','ok','12 d ago','4 s']],
 Projects:[['gate-check','Gate check','gate-check.py plan.md N for a project.','ok','2 d ago','1 s',{args:['plan path','phase']}],['find-answers','Find answers','Lists answered _tyler/ items waiting to be applied.','ok','3 h ago','1 s'],['publish-dry','Publish (dry run)','What publish.sh would push to GitHub.','ok','4 d ago','7 s'],['va-intake','VA intake','Interactive intake in a terminal.','ok','13 d ago','—',{terminal:true}],['va-mos','VA MOS lookup','Conditions by MOS code.','ok','13 d ago','2 s'],['pl-rebuild','Rebuild punch list','Regenerates _ideas/needs-done index.','ok','1 d ago','3 s']],
 Memory:[['context-search','Context search','Recall from Hindsight + the Wiki.','ok','25 min ago','3 s',{args:['terms']}],['context-save','Context save','Save a durable note to Hindsight + Raw/.','ok','40 min ago','2 s',{args:['note']}]],
 Server:[['jev-doctor','Jev doctor','Is the Jev judgment service up?','ok','2 h ago','2 s'],['sorter-status','Sorter status','Download sorter queue and last run.','ok','2 h ago','1 s'],['server-docker','Docker status','Every container on server.','warn','2 h ago','3 s'],['server-shell','Server shell','SSH into server.','ok','1 d ago','—',{terminal:true}]],
 Wiki:[['librarian-run','Librarian run','Ingest Raw/ into the Wiki now.','bad','17 h ago','4 m',{confirm:true}],['librarian-status','Librarian status','Last run, queue, review inbox counts.','ok','17 h ago','1 s'],['wiki-audit','Weekly Wiki audit','Contradiction and staleness pass.','ok','5 d ago','3 m']],
 Tools:[['api-catalog','Is there a free API for…?','Keyword search over the public-APIs list; add --free in the box for no-key APIs.','ok','4 d ago','2 s',{args:['Keyword']}]],
 Backup:[['checkpoint','Checkpoint','Commit on the server and take a restic snapshot.','ok','31 h ago','48 s'],['backup-status','Backup status','Latest snapshots and repo health.','warn','31 h ago','4 s']],
};
const outputs = {
 doctor:['doctor.sh — laptop','','[ok]   hooks: settings.json → 6 scripts present','[ok]   context-search.sh: hindsight reachable (bank you)','[ok]   secrets.sh: .env present, 14 keys','[ok]   agents-sync.py: 41 CLAUDE.md copies current','[warn] restic: last snapshot 31 h ago','       fix: run Backup → Checkpoint','[ok]   syncthing: 3 devices, 0 out of sync','','1 warning, 0 failures'],
 heartbeats:['heartbeats — 10 jobs','','ok    commit.sh            12 min ago','ok    librarian            17 h ago','ok    wiki-audit           5 d ago','late  rss-report           2 d 17 h ago   (expected daily)','ok    backup               31 h ago','ok    sorter               2 h ago','ok    heartbeat-self       1 min ago','','9 ok, 1 late'],
 continuity:['continuity — 3 machines','','laptop   last seen now        workspace in sync','server   last seen 2 min ago  workspace in sync, git clean','desktop       last seen 6 d ago    workspace in sync (stale)','','all good'],
 'context-search':['recall "tab lease grace" (bank: you)','','1. [2026-10-09] Tab-owned lease with 60 s grace; close tab → chats keep running 60 s then stop.','2. [2026-10-08] you chose "accept interruption and explicit native-session resume"; no PTY supervisor.','3. [2026-10-07] Phase 7: ProviderService owns conversations, SQLite events.','','3 memories'],
 'backup-status':['restic — repo /mnt/backup/restic','','latest snapshot  7f1e3a2c  2026-10-10 12:40  2.1 GB','previous         a81c0d44  2026-10-09 12:40  2.1 GB','repo check       ok','','warning: 31 h since last snapshot'],
 'server-docker':['CONTAINER         STATUS            PORTS','hindsight         Up 9 days         8888','jev               Up 9 days         8890','librarian-cron    Exited (1) 17h    —','syncthing         Up 41 days        8384','dashboard         Up 3 days         5000','','1 exited'],
 'librarian-status':['librarian — server','','last run     2026-10-11 02:10  exit 1 (ENOSPC on /var)','queue        3 Raw/ files','review inbox 3 pages pending, 1 merge, 2 reject','','next run     02:10 tomorrow'],
};
const genericOutput = (name) => [name + ' — laptop','','checking…','[ok] ' + name + ' completed','','0 warnings, 0 failures'];
const fmtClock = d => d.toLocaleDateString('en-US',{weekday:'short',month:'short',day:'numeric'}) + ', ' + d.toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'});
return { now, sessions, history, files, fileBody, terminal, commands, queue, notifications, inbox, audit, logs, stats, solo, apps, tools, pages, scripts, outputs, genericOutput, fmtClock };
})();
