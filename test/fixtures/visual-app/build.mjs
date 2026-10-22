import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(root, "dist");
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, "assets"), { recursive: true });
const strip = (code) => code.replace(/\n\s+/g, "\n");
fs.writeFileSync(path.join(out, "assets", "app-a1b2c3d4.js"), strip(fs.readFileSync(path.join(root, "src", "app.js"), "utf8")));
fs.writeFileSync(path.join(out, "assets", "cart-e5f6a7b8.js"), strip(fs.readFileSync(path.join(root, "src", "cart.js"), "utf8")));
fs.writeFileSync(path.join(out, "assets", "style-c9d0e1f2.css"), strip(fs.readFileSync(path.join(root, "src", "style.css"), "utf8")));
fs.writeFileSync(path.join(out, "index.html"), fs.readFileSync(path.join(root, "src", "index.html"), "utf8")
  .replace("/style.css", "/assets/style-c9d0e1f2.css")
  .replace("/app.js", "/assets/app-a1b2c3d4.js"));
