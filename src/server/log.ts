type Fields = Record<string, string | number | boolean | null | undefined>;

function write(level: "info" | "warn" | "error", msg: string, fields: Fields): void {
	const line = JSON.stringify({ t: new Date().toISOString(), level, msg, ...fields });
	(level === "info" ? process.stdout : process.stderr).write(`${line}\n`);
}

export const log = {
	info: (msg: string, fields: Fields = {}) => write("info", msg, fields),
	warn: (msg: string, fields: Fields = {}) => write("warn", msg, fields),
	error: (msg: string, fields: Fields = {}) => write("error", msg, fields),
};
