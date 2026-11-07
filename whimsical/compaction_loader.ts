import { Loader } from "@earendil-works/pi-tui";
import { INTERVAL_MS, sparkleFrames } from "./animation.ts";

// Compaction loaders ignore setWorkingIndicator. Wrap the compacting line in
// frames so color + symbols apply to "Compacting... (escape to cancel)".
// ponytail: Loader patch; drop when pi exposes compaction indicator options
export function installCompactionIndicator(): void {
	type LoaderMut = { message: string; setIndicator: Loader["setIndicator"] };
	const loaderProto = Loader.prototype as unknown as LoaderMut;
	const WHIMSICAL_PATCH = Symbol.for("whimsical.compactionLoader");
	if (!(WHIMSICAL_PATCH in loaderProto)) {
		(loaderProto as unknown as Record<symbol, boolean>)[WHIMSICAL_PATCH] = true;
		const setIndicator = loaderProto.setIndicator;
		loaderProto.setIndicator = function (this: LoaderMut, indicator) {
			if (/compacting/i.test(this.message)) {
				const message = this.message;
				this.message = "";
				setIndicator.call(this, {
					frames: sparkleFrames(message),
					intervalMs: INTERVAL_MS,
				});
				return;
			}
			setIndicator.call(this, indicator);
		};
	}
}
