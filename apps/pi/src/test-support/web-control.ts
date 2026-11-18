import { createConnection } from "node:net";

// One word on the dashboard's control socket, and its answer.
export function control(socket: string, word: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let text = "";
    const connection = createConnection({ path: `${socket}-control` });
    connection.setEncoding("utf8");
    connection.on("connect", () => connection.write(`${word}\n`));
    connection.on("data", (chunk: string) => (text += chunk));
    connection.on("end", () => resolve(text.trim()));
    connection.on("error", reject);
  });
}
