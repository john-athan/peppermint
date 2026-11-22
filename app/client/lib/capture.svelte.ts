// The capture sheet is one for the whole app: the camera button on Today, Investigate in Studio, a reader's tip and
// photos shared from another app all open it, with whatever they bring already in.
export const capture = $state({ open: false, files: [] as File[], note: "" });
export function openCapture(files: File[] = [], note = "") { capture.files = files; capture.note = note; capture.open = true; }
