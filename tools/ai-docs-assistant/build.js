import esbuild from "esbuild";
import path from "path";
import { chmod, rm } from "fs/promises";

const esbuildOptions = {
  entryPoints: [path.join(process.cwd(), "./src/index.ts")],
  bundle: true,
  outfile: path.join(process.cwd(), "./dist/index.cjs"),
  platform: "node",
  banner: { js: "#!/usr/bin/env node" },
};

try {
  await rm("./dist", { recursive: true, force: true });
  await esbuild.build(esbuildOptions);
  await chmod(esbuildOptions.outfile, "755");
} catch (er) {
  console.error(er);
  process.exit(1);
}
