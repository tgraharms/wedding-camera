import React from "react";
import ReactDOM from "react-dom/client";
import { Root } from "./Root";
import "./index.css";
import "./guest-album.css";

console.info(`kamera-majlis build ${__BUILD_ID__}`);

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Root pathname={window.location.pathname} />
  </React.StrictMode>
);
