// CSS files imported as strings (via tsup's `loader: { ".css": "text" }`).
// Pure build-time shim — emits no runtime code.
declare module "*.css" {
  const content: string
  export default content
}
