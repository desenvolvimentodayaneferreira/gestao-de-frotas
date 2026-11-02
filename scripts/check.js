// Confere a sintaxe de todos os arquivos JavaScript do sistema.
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const files = ["electron/main.js", "electron/preload.js", ...fs.readdirSync(path.join(root, "src/js")).map((name) => `src/js/${name}`)];
let failed = false;
for (const file of files) {
  try {
    execFileSync(process.execPath, ["--check", path.join(root, file)], { stdio: "pipe" });
    console.log(`ok  ${file}`);
  } catch (error) {
    failed = true;
    console.error(`ERRO ${file}\n${error.stderr}`);
  }
}
process.exit(failed ? 1 : 0);
