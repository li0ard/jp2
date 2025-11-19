// from https://github.com/runk/jpeg2000

export interface Tile {
    height: number;
    width: number;
    top: number;
    left: number;
    items: Uint8ClampedArray;
}
  
export declare class JpxImage {
    constructor(data: Uint8Array);
    width: number;
    height: number;
    componentsCount: number;
    tiles: Tile[];
}