import type { Example } from "./types";

/// Read a named route parameter and return a greeting.
const code = `async fn main {
  let app = @mocket.App()
  app.use_middleware(@cors.handle_cors())

  // Visit /hello/MoonBit to read a named route parameter.
  app.get("/hello/:name", event => {
    let name = event.params.get("name").unwrap_or("World")
    "Hello, \\{name}!"
  })

  app.listen(":4000")
}
`;

export const example: Example = {
  name: "params",
  label: "Route parameters",
  subtitle: "/:name",
  code,
};
