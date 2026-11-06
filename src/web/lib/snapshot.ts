function stamp(date: Date): string {
	const pad = (n: number) => String(n).padStart(2, "0");
	const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
	return `${day}_${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
}

/** Saves the frame on screen at the stream's own resolution, not the tile's size. */
export function saveSnapshot({ video, name }: { video: HTMLVideoElement; name: string }): void {
	if (video.videoWidth === 0) return;
	const canvas = document.createElement("canvas");
	canvas.width = video.videoWidth;
	canvas.height = video.videoHeight;
	canvas.getContext("2d")?.drawImage(video, 0, 0);
	canvas.toBlob((blob) => {
		if (!blob) return;
		const link = document.createElement("a");
		link.href = URL.createObjectURL(blob);
		link.download = `${name.replace(/[^\w-]+/g, "-")}_${stamp(new Date())}.png`;
		link.click();
		URL.revokeObjectURL(link.href);
	}, "image/png");
}
