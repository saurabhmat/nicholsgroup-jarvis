// Prints the next approved task whose dependencies are done (from docs/backlog.md on main).
import { readFileSync } from "node:fs";
const md = readFileSync("docs/backlog.md", "utf8");
const tasks = md.split(/^### /m).slice(1).map(block => {
  const id = (block.match(/^(T-\d+)/) || [])[1];
  const status = (block.match(/- status:\s*([\w-]+)/) || [])[1];
  const deps = ((block.match(/- depends:\s*(.*)/) || [])[1] || "")
    .split(",").map(s => s.trim()).filter(s => /^T-\d+$/.test(s));
  return { id, status, deps };
}).filter(t => t.id);
const done = new Set(tasks.filter(t => t.status === "done").map(t => t.id));
const next = tasks.find(t => t.status === "approved" && t.deps.every(d => done.has(d)));
if (next) console.log(next.id);
