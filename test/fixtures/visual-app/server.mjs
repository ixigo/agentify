import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "src");
const port = Number(process.argv[process.argv.indexOf("--port") + 1] || process.env.PORT || 4391);
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" };
const routes = { "/": "index.html", "/menu": "index.html", "/checkout": "index.html" };

createServer(async (request, response) => {
  const url = new URL(request.url, "http://localhost");
  if (url.pathname === "/api/menu") {
    response.writeHead(url.searchParams.get("fail") ? 500 : 200, { "content-type": "application/json" });
    response.end(JSON.stringify(url.searchParams.get("fail") ? { error: "menu unavailable" } : { items: [{ name: "Paneer Thali", price: 189 }, { name: "Veg Biryani", price: 149 }] }));
    return;
  }
  const file = routes[url.pathname] ?? url.pathname.slice(1);
  try {
    const body = await readFile(path.join(root, path.normalize(file)));
    response.writeHead(200, { "content-type": types[path.extname(file)] ?? "application/octet-stream" });
    response.end(body);
  } catch {
    response.writeHead(404, { "content-type": "text/html" });
    response.end("<h1>Not found</h1>");
  }
}).listen(port, "127.0.0.1");
