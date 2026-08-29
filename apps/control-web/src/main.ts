import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app.ts";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("control-web root is missing");
createRoot(root).render(React.createElement(React.StrictMode, null, React.createElement(App)));
