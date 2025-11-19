import { JpxImage } from './jpeg2000/index.js';
import UPNG from "@pdf-lib/upng";

/**
 * Convert JPEG2000 (`.jp2`) to PNG
 * @param data JPEG2000 buffer
 */
export const jp2ToPNG = (data: Uint8Array): Uint8Array[] => {
    const jpx = new JpxImage(data);
    const result: Uint8Array[] = [];
    for(let tile of jpx.tiles) {
        const rgba = new Uint8Array(tile.width * tile.height * 4);
        for (let i = 0, j = 0; i < tile.items.length; i += 3, j += 4) {
            rgba[j] = tile.items[i];
            rgba[j+1] = tile.items[i+1];
            rgba[j+2] = tile.items[i+2];
            rgba[j+3] = 255;
        }
        result.push(new Uint8Array(UPNG.encode([rgba.buffer as ArrayBuffer], tile.width, tile.height, 0)));
    }

    return result;
}

await Bun.write("EF_DG2.png", jp2ToPNG(await Bun.file("./EF_DG2.jp2").bytes()))
await Bun.write("NM1.png", jp2ToPNG(await Bun.file("./NM1.j2k").bytes()))