import { VERSION } from "./server.js";

export const USAGE = `alza-mcp-community ${VERSION} - unofficial MCP server for Alza.cz

Usage: alza-mcp-community [--stdio | --http [--port N] [--host H]]
       alza-mcp-community --setup-cf
       alza-mcp-community --login

  --stdio        Serve MCP over stdin/stdout (default)
  --http         Serve MCP over Streamable HTTP (default 127.0.0.1:3000/mcp)
  --port N       HTTP port (needs --http); also ALZA_HTTP_PORT or PORT
  --host H       HTTP bind address (needs --http); also ALZA_HTTP_HOST
  --setup-cf     Create the optional curl_cffi venv (.venv-cf) with Python, then exit.
                 Cross-platform (no bash); for .mcpb and --ignore-scripts installs.
                 Honours ALZA_MCP_SKIP_VENV=1. Never runs automatically.
  --login        Open Chrome/Edge, sign in to Alza by hand, and save the web session
                 (ALZA_WEB_SESSION_FILE, default ~/.alza-mcp/web-session.json) so the
                 catalog tools show your account's prices. Then exit.
  -h, --help     Show this help and exit
  -v, --version  Print the version and exit

Configuration is read from environment variables (ALZA_BASE_URL, ALZA_PROXY_URL,
ALZA_TOKEN_FILE, ALZA_TRANSPORT, ...); see the README.
`;

/** Handle `--help` / `--version` before any config is parsed. Returns the text to print, or undefined. */
export function informationalOutput(argv: string[]): string | undefined {
  if (argv.includes("-h") || argv.includes("--help")) return USAGE;
  if (argv.includes("-v") || argv.includes("--version")) return `${VERSION}\n`;
  return undefined;
}

/** `--setup-cf` is a one-shot command, handled before any server config is parsed. */
export function isSetupCf(argv: string[]): boolean {
  return argv.includes("--setup-cf");
}

/** `--login` is a one-shot command, handled before any server config is parsed. */
export function isWebLogin(argv: string[]): boolean {
  return argv.includes("--login");
}

/** Wire-format JSON-RPC reply for a line the stdio transport could not parse (id is unknowable, so null). */
export function replyForTransportError(err: unknown): string | undefined {
  if (!err || typeof err !== "object") return undefined;
  if (err instanceof SyntaxError) {
    return JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error: invalid JSON" } }) + "\n";
  }
  if ((err as { name?: string }).name === "ZodError") {
    return JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request: not a valid JSON-RPC 2.0 message" } }) + "\n";
  }
  return undefined;
}
