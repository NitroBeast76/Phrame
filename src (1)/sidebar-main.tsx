import React from "react";
import ReactDOM from "react-dom/client";
import Sidebar from "./Sidebar";
import "./Sidebar.css";
import "./sidebar-theme.css";

document.addEventListener("contextmenu", (e) => e.preventDefault());

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
	<React.StrictMode>
		<Sidebar />
	</React.StrictMode>
);
