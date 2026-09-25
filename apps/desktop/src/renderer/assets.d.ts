// Vite asset URL imports (e.g. the pdf.js worker).
declare module "*?url" {
  const url: string;
  export default url;
}
