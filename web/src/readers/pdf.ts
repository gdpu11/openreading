// Keep the API and worker on the same build and WebView compatibility helpers.
import "./pdfCompatibility";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import worker from "./pdf.worker?worker&url";

pdfjs.GlobalWorkerOptions.workerSrc = worker;
export * from "pdfjs-dist/legacy/build/pdf.mjs";
