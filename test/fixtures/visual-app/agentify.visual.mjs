export default {
  server: { command: ["node", "server.mjs", "--port", "{port}"], readyPath: "/" },
  clients: [
    { id: "default", label: "Default brand" },
    { id: "green", label: "Green partner", query: { client: "green" } },
  ],
  defaultViewports: ["mobile"],
  flows: [
    { id: "home", group: "Pages", title: "Home", start: { path: "/" } },
    {
      id: "order",
      group: "Flows",
      title: "Add an item",
      start: { path: "/" },
      steps: [
        { id: "home", title: "Home", noShot: true },
        {
          id: "menu",
          title: "Menu",
          run: async ({ page, expect }) => {
            await page.getByRole("link", { name: "See the menu" }).click();
            await expect(page.getByRole("heading", { name: "Menu" })).toBeVisible();
          },
        },
        {
          id: "added",
          title: "Item added",
          run: async ({ page, expect }) => {
            await page.getByRole("button", { name: "Add" }).first().click();
            await expect(page.getByText("1 item added")).toBeVisible();
          },
        },
      ],
    },
    { id: "menu-error", group: "States", title: "Menu failed", start: { path: "/menu", query: { fail: 1 } } },
  ],
  build: { command: ["node", "build.mjs"], outDir: "dist" },
};
