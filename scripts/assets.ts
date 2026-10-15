import { copyFile, mkdir } from "node:fs/promises";

await mkdir(new URL("../dist/public/", import.meta.url), { recursive: true });
for (const file of ["index.html", "console.css"]) {
  await copyFile(
    new URL(`../public/${file}`, import.meta.url),
    new URL(`../dist/public/${file}`, import.meta.url)
  );
}

await copyFile(
  new URL("../verify/package.json", import.meta.url),
  new URL("../dist/verify/package.json", import.meta.url)
);

await mkdir(new URL("../dist/public/pilot/", import.meta.url), {
  recursive: true,
});
for (const file of ["index.html", "pilot.css", "app.js"]) {
  await copyFile(
    new URL(`../public/pilot/${file}`, import.meta.url),
    new URL(`../dist/public/pilot/${file}`, import.meta.url)
  );
}
