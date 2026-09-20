import type { Example } from "./types";

/// A minimal Mocket hello world — visit /hello/MoonBit to see the greeting.
const code = `/// A minimal Mocket hello world — visit /hello/MoonBit to see the greeting.
async fn main {
  let app = @mocket.App()

  app.get("/hello/:name", event => {
    let name = event.params.get("name").unwrap_or("World")
    "Hello, \\{name}!"
  })

  app.listen(":4000")
}
`;

export const example: Example = {
  name: "hello",
  label: "Hello world",
  subtitle: "/hello/:name",
  code,
};
