import "./DashboardProfile.css";

// The graph-paper backdrop shared by the Profile, Windows and Media tabs: a grid, an axis with ticks,
// a scope trace and a slow scan line. Its look is in DashboardProfile.css (.dash-pf-*), and the
// card that holds it needs the "dash-pf" class (variables, clipping, stacking).
export function ScopeBackdrop({ trace }: { trace: string }) {
	return (
		<div className="dash-pf-bg" aria-hidden>
			<span className="dash-pf-axis" />
			<svg className="dash-pf-scope" viewBox="0 0 600 100" preserveAspectRatio="none">
				<polyline className="ghost-a" points={trace} />
				<polyline className="ghost-b" points={trace} />
				<polyline className="main" points={trace} />
			</svg>
			<span className="dash-pf-sweep" />
		</div>
	);
}
