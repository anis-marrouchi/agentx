// Vite turns a CSS import into a stylesheet on the page.
declare module "*.css"
// Vite turns an image import into its hashed URL.
declare module "*.webp" { const url: string; export default url }
