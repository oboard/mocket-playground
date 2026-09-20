import type { Example } from "./types";

/// Group routes under a shared prefix and respond with JSON.
const code = `async fn main {
  let app = @mocket.App()
  app.use_middleware(@cors.handle_cors())

  app.group("/api", group => {
    group.get("/status", _ => {
      ({ "ok": true, "framework": "mocket" } : Json)
    })
  })

  app.listen(":4000")
}
`;

export const example: Example = {
  name: "api",
  label: "API group",
  subtitle: "/api/status JSON",
  code,
};
