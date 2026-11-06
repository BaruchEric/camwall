import { useCallback, useEffect, useState } from "react";
import type { AppState, StatePatch } from "@/shared/schema";
import { Workspace } from "@/web/components/Workspace";
import { api } from "@/web/lib/api";

function toPatch({ cameras, groups, views }: AppState): StatePatch {
	return {
		cameras: cameras.map(({ id, name, groupId }) => ({ id, name, groupId })),
		groups,
		views,
	};
}

export function App() {
	const [state, setState] = useState<AppState | null>(null);
	const [error, setError] = useState<string | null>(null);

	const load = useCallback(() => {
		api.state().then(
			(next) => {
				setState(next);
				setError(null);
			},
			(cause: unknown) => setError(cause instanceof Error ? cause.message : "No answer"),
		);
	}, []);

	useEffect(() => {
		load();
		window.addEventListener("focus", load);
		return () => window.removeEventListener("focus", load);
	}, [load]);

	const commit = useCallback((next: AppState) => {
		setState(next);
		api.saveState(toPatch(next)).then(setState, (cause: unknown) => {
			setError(cause instanceof Error ? cause.message : "Saving failed");
		});
	}, []);

	if (state === null) {
		return <div className="boot">{error ? `Camwall server: ${error}` : "Loading"}</div>;
	}
	return (
		<>
			{error && (
				<button type="button" className="banner" onClick={() => setError(null)}>
					{error}. Click to dismiss.
				</button>
			)}
			<Workspace state={state} commit={commit} onLoaded={setState} />
		</>
	);
}
