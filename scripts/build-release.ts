import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import packageJson from "../package.json";

const rootDir = import.meta.dir + "/..";
const distDir = join(rootDir, "dist");
const releaseDir = join(distDir, "release");
const binaryName = packageJson.name;
const binaryPath = join(distDir, binaryName);
const binaryOnly = process.argv.includes("--binary-only");

if (process.platform !== "linux") {
  throw new Error(
    `${packageJson.name} currently targets Linux because it depends on Niri.`,
  );
}

async function buildBinary() {
  await mkdir(distDir, { recursive: true });

  await Bun.$`bun build --compile --minify --bytecode --outfile ${binaryPath} ./index.ts`.cwd(
    rootDir,
  );

  return binaryPath;
}

async function packageRelease(executablePath: string) {
  const archiveBaseName = `${packageJson.name}-v${packageJson.version}-linux-${process.arch}`;
  const stagingDir = join(releaseDir, archiveBaseName);
  const archivePath = join(releaseDir, `${archiveBaseName}.tar.gz`);
  const checksumPath = `${archivePath}.sha256`;
  const installScriptSource = join(rootDir, "scripts", "install.sh");

  await rm(stagingDir, { recursive: true, force: true });
  await mkdir(stagingDir, { recursive: true });
  await mkdir(releaseDir, { recursive: true });

  await copyFile(executablePath, join(stagingDir, binaryName));
  await copyFile(join(rootDir, "README.md"), join(stagingDir, "README.md"));
  await copyFile(join(rootDir, ".env.example"), join(stagingDir, ".env.example"));
  await copyFile(installScriptSource, join(stagingDir, basename(installScriptSource)));

  await Bun.$`tar -czf ${archivePath} -C ${releaseDir} ${archiveBaseName}`;

  const archiveBytes = await readFile(archivePath);
  const sha256 = createHash("sha256").update(archiveBytes).digest("hex");
  await writeFile(checksumPath, `${sha256}  ${basename(archivePath)}\n`);

  return { archivePath, checksumPath };
}

const executablePath = await buildBinary();
console.log(`[build] executable: ${executablePath}`);

if (!binaryOnly) {
  const { archivePath, checksumPath } = await packageRelease(executablePath);
  console.log(`[build] archive: ${archivePath}`);
  console.log(`[build] sha256: ${checksumPath}`);
}
