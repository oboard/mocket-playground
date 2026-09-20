import type { Example } from "./types";

/// Echo the POST body back to the client.
const code = `async fn main {
  let app = @mocket.App()
  app.use_middleware(@cors.handle_cors())

  app.post("/echo", event => {
    let body : Bytes = event.req.body()
    body
  })

  app.listen(":4000")
}
`;

export const example: Example = {
  name: "echo",
  label: "POST echo",
  subtitle: "request body",
  code,
};
