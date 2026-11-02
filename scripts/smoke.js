// Autoteste: abre o sistema numa pasta de dados temporária, entra como administrador de teste,
// confere banco, gráficos e mapa e salva uma captura da tela. Nunca toca nos dados reais.
// Uso: npm run smoke                      (código-fonte)
//      npm run smoke -- "caminho\do\programa.exe"   (programa instalado ou empacotado)
const { spawn } = require("child_process");
const path = require("path");

const root = path.join(__dirname, "..");
const target = process.argv[2];
const command = target || require("electron");
const args = target ? [] : [root];

const child = spawn(command, args, { cwd: root, env: { ...process.env, FROTAS_SMOKE_TEST: "1" } });
let output = "";
child.stdout.on("data", (chunk) => (output += chunk));
child.stderr.on("data", (chunk) => (output += chunk));

const timer = setTimeout(() => {
  child.kill();
  console.error("ERRO: o sistema não respondeu em 3 minutos.");
  process.exit(1);
}, 180000);

child.on("exit", () => {
  clearTimeout(timer);
  const line = output.split(/\r?\n/).find((text) => text.startsWith("SMOKE_RESULT "));
  if (!line) {
    console.error(`ERRO: o autoteste não terminou.\n${output.slice(-2000)}`);
    process.exit(1);
  }
  const result = JSON.parse(line.slice("SMOKE_RESULT ".length));
  // Com a planilha (código-fonte) precisa haver veículos; no instalador, que vem sem dados reais, o banco começa vazio.
  const dadosOk = result.seed ? result.vehicles > 0 : result.vehicles >= 0;
  const ok = !result.failed && result.desktopBridge && dadosOk && result.savedBytes > 0
    && result.chartJs === "function" && result.leaflet === "object" && !result.errors.length;
  console.log(JSON.stringify(result, null, 2));
  console.log(ok ? "AUTOTESTE OK" : "AUTOTESTE FALHOU");
  process.exit(ok ? 0 : 1);
});
