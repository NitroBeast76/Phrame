import React from "react";
import ReactDOM from "react-dom/client";
import SidebarFrame from "./SidebarFrame";
import "./sidebar-theme.css";

document.addEventListener("contextmenu", (e) => e.preventDefault());

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
	<React.StrictMode>
		<SidebarFrame />
	</React.StrictMode>
);
