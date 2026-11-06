function stamp(date: Date): string {
	const pad = (n: number) => String(n).padStart(2, "0");
	const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
	return `${day}_${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
}

/** The frame on screen at the stream's own resolution, not the tile's size. */
function grabFrame(video: HTMLVideoElement): Promise<Blob | null> {
	return new Promise((resolve) => {
		if (video.videoWidth === 0) {
			resolve(null);
			return;
		}
		const canvas = document.createElement("canvas");
		canvas.width = video.videoWidth;
		canvas.height = video.videoHeight;
		canvas.getContext("2d")?.drawImage(video, 0, 0);
		canvas.toBlob(resolve, "image/png");
	});
}

export async function saveSnapshot({
	video,
	name,
}: {
	video: HTMLVideoElement;
	name: string;
}): Promise<void> {
	const blob = await grabFrame(video);
	if (!blob) return;
	const link = document.createElement("a");
	link.href = URL.createObjectURL(blob);
	link.download = `${name.replace(/[^\w-]+/g, "-")}_${stamp(new Date())}.png`;
	link.click();
	URL.revokeObjectURL(link.href);
}

/** Browsers only hand images to the clipboard on https or localhost. */
export function canCopyImage(): boolean {
	return window.isSecureContext && "ClipboardItem" in window;
}

/** The frame goes in as a promise, because Safari refuses a write that follows an await. */
export async function copySnapshot(video: HTMLVideoElement): Promise<boolean> {
	const png = grabFrame(video).then((blob) => blob ?? Promise.reject(new Error("No picture")));
	await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
	return true;
}

/** Text still copies over plain http, such as a Tailscale address, through the old command. */
export async function copyText(text: string): Promise<boolean> {
	if (window.isSecureContext) {
		await navigator.clipboard.writeText(text);
		return true;
	}
	const field = document.createElement("textarea");
	field.value = text;
	(document.querySelector("dialog[open]") ?? document.body).append(field);
	field.select();
	const copied = document.execCommand("copy");
	field.remove();
	return copied;
}
