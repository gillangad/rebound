import "@/server/load-env";
import { spawn, type ChildProcess } from "node:child_process";

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const children: ChildProcess[] = [];
let stopping = false;

function stopAll() {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill("SIGINT");
}

function start(command: string, args: string[]) {
  const child = process.platform === "win32"
    ? spawn(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", npm, "run", command, ...args], { stdio: "inherit", env: process.env })
    : spawn(npm, ["run", command, ...args], { stdio: "inherit", env: process.env });
  children.push(child);
  child.on("exit", (code) => {
    if (!stopping && code && code !== 0) {
      console.error(`[dev:all] ${command} exited with code ${code}.`);
      process.exitCode = code;
      stopAll();
    }
  });
}

process.on("SIGINT", stopAll);
process.on("SIGTERM", stopAll);

start("dev:web", []);
if (process.env.DATABASE_URL) {
  start("worker", []);
} else {
  console.warn("[dev:all] DATABASE_URL is not set; running the fixture web server without the durable worker.");
}

await new Promise<void>((resolve) => {
  const check = () => {
    if (stopping && children.every((child) => child.exitCode !== null || child.killed)) resolve();
    else setTimeout(check, 100);
  };
  check();
});
