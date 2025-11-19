// from https://github.com/runk/jpeg2000

/* Copyright 2012 Mozilla Foundation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
import { ArithmeticDecoder, log2, readUint16, readUint32 } from "./utils.js"
import { SubbandsGainLog2, UNIFORM_CONTEXT, RUNLENGTH_CONTEXT, LLAndLHContextsLabel, HLContextLabel, HHContextLabel } from "./const.js"

class JpxError extends Error {
    constructor(msg) { super(`JPX error: ${msg}`); }
}

export class JpxImage {
    failOnCorruptedImage = false;
    tiles;
    width;
    height;
    componentsCount;

    constructor(data) {
        const head = readUint16(data, 0);
        // No box header, immediate start of codestream (SOC)
        if (head === 0xff4f) {
            this.parseCodestream(data, 0, data.length);
            return;
        }

        let position = 0;
        const length = data.length;
        while (position < length) {
            let headerSize = 8;
            let lbox = readUint32(data, position);
            const tbox = readUint32(data, position + 4);
            position += headerSize;
            if (lbox === 1) {
                // XLBox: read UInt64 according to spec.
                // JavaScript's int precision of 53 bit should be sufficient here.
                lbox = readUint32(data, position) * 4294967296 + readUint32(data, position + 4);
                position += 8;
                headerSize += 8;
            }
            if (lbox === 0) lbox = length - position + headerSize;
            if (lbox < headerSize) throw new JpxError("Invalid box field size");
            const dataLength = lbox - headerSize;
            let jumpDataLength = true;
            switch (tbox) {
                case 0x6a703268: // 'jp2h'
                    jumpDataLength = false; // parsing child boxes
                    break;
                case 0x636f6c72: // 'colr'
                    // Colorspaces are not used, the CS from the PDF is used.
                    let method = data[position];
                    if (method === 1) {
                        // enumerated colorspace
                        let colorspace = readUint32(data, position + 3);
                        switch (colorspace) {
                            case 16: // this indicates a sRGB colorspace
                            case 17: // this indicates a grayscale colorspace
                            case 18: // this indicates a YUV colorspace
                                break;
                            default:
                                console.warn("Unknown colorspace " + colorspace);
                                break;
                        }
                    }
                    else if (method === 2) console.log("ICC profile not supported");
                    break;
                case 0x6a703263: // 'jp2c'
                    this.parseCodestream(data, position, position + dataLength);
                    break;
                case 0x6a502020: // 'jP\024\024'
                    if (readUint32(data, position) !== 0x0d0a870a) console.warn("Invalid JP2 signature");
                    break;
                // The following header types are valid but currently not used:
                case 0x6a501a1a: // 'jP\032\032'
                case 0x66747970: // 'ftyp'
                case 0x72726571: // 'rreq'
                case 0x72657320: // 'res '
                case 0x69686472: // 'ihdr'
                    break;
                default:
                    let headerType = String.fromCharCode((tbox >> 24) & 0xff, (tbox >> 16) & 0xff, (tbox >> 8) & 0xff, tbox & 0xff);
                    console.warn("Unsupported header type " + tbox + " (" + headerType + ")");
                    break;
            }
            if (jumpDataLength) position += dataLength;
        }
    }
    parseCodestream(data, start, end) {
        let context = {};
        let doNotRecover = false;
        try {
            let position = start;
            while (position + 1 < end) {
                let code = readUint16(data, position);
                position += 2;

                let length = 0, j, sqcd, spqcds, spqcdSize, scalarExpounded, tile;
                switch (code) {
                    case 0xff4f: // Start of codestream (SOC)
                        context.mainHeader = true;
                        break;
                    case 0xffd9: // End of codestream (EOC)
                        break;
                    case 0xff51: // Image and tile size (SIZ)
                        length = readUint16(data, position);
                        let siz = {};
                        siz.Xsiz = readUint32(data, position + 4);
                        siz.Ysiz = readUint32(data, position + 8);
                        siz.XOsiz = readUint32(data, position + 12);
                        siz.YOsiz = readUint32(data, position + 16);
                        siz.XTsiz = readUint32(data, position + 20);
                        siz.YTsiz = readUint32(data, position + 24);
                        siz.XTOsiz = readUint32(data, position + 28);
                        siz.YTOsiz = readUint32(data, position + 32);
                        let componentsCount = readUint16(data, position + 36);
                        siz.Csiz = componentsCount;
                        let components = [];
                        j = position + 38;
                        for (let i = 0; i < componentsCount; i++) {
                            let component = {
                                precision: (data[j] & 0x7f) + 1,
                                isSigned: !!(data[j] & 0x80),
                                XRsiz: data[j + 1],
                                YRsiz: data[j + 2],
                            };
                            j += 3;
                            calculateComponentDimensions(component, siz);
                            components.push(component);
                        }
                        context.SIZ = siz;
                        context.components = components;
                        calculateTileGrids(context, components);
                        context.QCC = [];
                        context.COC = [];
                        break;
                    case 0xff5c: // Quantization default (QCD)
                        length = readUint16(data, position);
                        let qcd = {};
                        j = position + 2;
                        sqcd = data[j++];
                        switch (sqcd & 0x1f) {
                            case 0:
                                spqcdSize = 8;
                                scalarExpounded = true;
                                break;
                            case 1:
                                spqcdSize = 16;
                                scalarExpounded = false;
                                break;
                            case 2:
                                spqcdSize = 16;
                                scalarExpounded = true;
                                break;
                            default:
                                throw new Error("Invalid SQcd value " + sqcd);
                        }
                        qcd.noQuantization = spqcdSize === 8;
                        qcd.scalarExpounded = scalarExpounded;
                        qcd.guardBits = sqcd >> 5;
                        spqcds = [];
                        while (j < length + position) {
                            let spqcd = {};
                            if (spqcdSize === 8) {
                                spqcd.epsilon = data[j++] >> 3;
                                spqcd.mu = 0;
                            } else {
                                spqcd.epsilon = data[j] >> 3;
                                spqcd.mu = ((data[j] & 0x7) << 8) | data[j + 1];
                                j += 2;
                            }
                            spqcds.push(spqcd);
                        }
                        qcd.SPqcds = spqcds;
                        if (context.mainHeader) context.QCD = qcd;
                        else {
                            context.currentTile.QCD = qcd;
                            context.currentTile.QCC = [];
                        }
                        break;
                    case 0xff5d: // Quantization component (QCC)
                        length = readUint16(data, position);
                        let qcc = {};
                        j = position + 2;
                        let cqcc;
                        if (context.SIZ.Csiz < 257) cqcc = data[j++];
                        else {
                            cqcc = readUint16(data, j);
                            j += 2;
                        }
                        sqcd = data[j++];
                        switch (sqcd & 0x1f) {
                            case 0:
                                spqcdSize = 8;
                                scalarExpounded = true;
                                break;
                            case 1:
                                spqcdSize = 16;
                                scalarExpounded = false;
                                break;
                            case 2:
                                spqcdSize = 16;
                                scalarExpounded = true;
                                break;
                            default:
                                throw new Error("Invalid SQcd value " + sqcd);
                        }
                        qcc.noQuantization = spqcdSize === 8;
                        qcc.scalarExpounded = scalarExpounded;
                        qcc.guardBits = sqcd >> 5;
                        spqcds = [];
                        while (j < length + position) {
                            let spqcd = {};
                            if (spqcdSize === 8) {
                                spqcd.epsilon = data[j++] >> 3;
                                spqcd.mu = 0;
                            } else {
                                spqcd.epsilon = data[j] >> 3;
                                spqcd.mu = ((data[j] & 0x7) << 8) | data[j + 1];
                                j += 2;
                            }
                            spqcds.push(spqcd);
                        }
                        qcc.SPqcds = spqcds;
                        if (context.mainHeader) context.QCC[cqcc] = qcc;
                        else context.currentTile.QCC[cqcc] = qcc;
                        break;
                    case 0xff52: // Coding style default (COD)
                        length = readUint16(data, position);
                        let cod = {};
                        j = position + 2;
                        let scod = data[j++];
                        cod.entropyCoderWithCustomPrecincts = !!(scod & 1);
                        cod.sopMarkerUsed = !!(scod & 2);
                        cod.ephMarkerUsed = !!(scod & 4);
                        cod.progressionOrder = data[j++];
                        cod.layersCount = readUint16(data, j);
                        j += 2;
                        cod.multipleComponentTransform = data[j++];

                        cod.decompositionLevelsCount = data[j++];
                        cod.xcb = (data[j++] & 0xf) + 2;
                        cod.ycb = (data[j++] & 0xf) + 2;
                        let blockStyle = data[j++];
                        cod.selectiveArithmeticCodingBypass = !!(blockStyle & 1);
                        cod.resetContextProbabilities = !!(blockStyle & 2);
                        cod.terminationOnEachCodingPass = !!(blockStyle & 4);
                        cod.verticallyStripe = !!(blockStyle & 8);
                        cod.predictableTermination = !!(blockStyle & 16);
                        cod.segmentationSymbolUsed = !!(blockStyle & 32);
                        cod.reversibleTransformation = data[j++];
                        if (cod.entropyCoderWithCustomPrecincts) {
                            let precinctsSizes = [];
                            while (j < length + position) {
                                let precinctsSize = data[j++];
                                precinctsSizes.push({
                                    PPx: precinctsSize & 0xf,
                                    PPy: precinctsSize >> 4,
                                });
                            }
                            cod.precinctsSizes = precinctsSizes;
                        }
                        let unsupported = [];
                        if (cod.selectiveArithmeticCodingBypass) unsupported.push("selectiveArithmeticCodingBypass");
                        if (cod.resetContextProbabilities) unsupported.push("resetContextProbabilities");
                        if (cod.terminationOnEachCodingPass) unsupported.push("terminationOnEachCodingPass");
                        if (cod.verticallyStripe) unsupported.push("verticallyStripe");
                        if (cod.predictableTermination) unsupported.push("predictableTermination");
                        if (unsupported.length > 0) {
                            doNotRecover = true;
                            console.warn(`JPX: Unsupported COD options (${unsupported.join(", ")}).`);
                        }
                        if (context.mainHeader) context.COD = cod;
                        else {
                            context.currentTile.COD = cod;
                            context.currentTile.COC = [];
                        }
                        break;
                    case 0xff90: // Start of tile-part (SOT)
                        length = readUint16(data, position);
                        tile = {};
                        tile.index = readUint16(data, position + 2);
                        tile.length = readUint32(data, position + 4);
                        tile.dataEnd = tile.length + position - 2;
                        tile.partIndex = data[position + 8];
                        tile.partsCount = data[position + 9];

                        context.mainHeader = false;
                        if (tile.partIndex === 0) {
                            // reset component specific settings
                            tile.COD = context.COD;
                            tile.COC = context.COC.slice(0); // clone of the global COC
                            tile.QCD = context.QCD;
                            tile.QCC = context.QCC.slice(0); // clone of the global COC
                        }
                        context.currentTile = tile;
                        break;
                    case 0xff93: // Start of data (SOD)
                        tile = context.currentTile;
                        if (tile.partIndex === 0) {
                            initializeTile(context, tile.index);
                            buildPackets(context);
                        }

                        // moving to the end of the data
                        length = tile.dataEnd - position;
                        parseTilePackets(context, data, position, length);
                        break;
                    case 0xff53: // Coding style component (COC)
                        console.warn("JPX: Codestream code 0xFF53 (COC) is not implemented.");
                    /* falls through */
                    case 0xff55: // Tile-part lengths, main header (TLM)
                    case 0xff57: // Packet length, main header (PLM)
                    case 0xff58: // Packet length, tile-part header (PLT)
                    case 0xff64: // Comment (COM)
                        length = readUint16(data, position);
                        // skipping content
                        break;
                    default:
                        throw new Error("Unknown codestream code: " + code.toString(16));
                }
                position += length;
            }
        } catch (e) {
            if (doNotRecover || this.failOnCorruptedImage) throw new JpxError(e.message);
            else console.warn(`JPX: Trying to recover from: "${e.message}".`);
        }
        this.tiles = transformComponents(context);
        this.width = context.SIZ.Xsiz - context.SIZ.XOsiz;
        this.height = context.SIZ.Ysiz - context.SIZ.YOsiz;
        this.componentsCount = context.SIZ.Csiz;
    }
}

const calculateComponentDimensions = (component, siz) => {
    // Section B.2 Component mapping
    component.x0 = Math.ceil(siz.XOsiz / component.XRsiz);
    component.x1 = Math.ceil(siz.Xsiz / component.XRsiz);
    component.y0 = Math.ceil(siz.YOsiz / component.YRsiz);
    component.y1 = Math.ceil(siz.Ysiz / component.YRsiz);
    component.width = component.x1 - component.x0;
    component.height = component.y1 - component.y0;
}

const calculateTileGrids = (context, components) => {
    let siz = context.SIZ;
    // Section B.3 Division into tile and tile-components
    let tiles = [];
    let numXtiles = Math.ceil((siz.Xsiz - siz.XTOsiz) / siz.XTsiz);
    let numYtiles = Math.ceil((siz.Ysiz - siz.YTOsiz) / siz.YTsiz);
    for (let q = 0; q < numYtiles; q++) {
        for (let p = 0; p < numXtiles; p++) {
            let tile = {};
            tile.tx0 = Math.max(siz.XTOsiz + p * siz.XTsiz, siz.XOsiz);
            tile.ty0 = Math.max(siz.YTOsiz + q * siz.YTsiz, siz.YOsiz);
            tile.tx1 = Math.min(siz.XTOsiz + (p + 1) * siz.XTsiz, siz.Xsiz);
            tile.ty1 = Math.min(siz.YTOsiz + (q + 1) * siz.YTsiz, siz.Ysiz);
            tile.width = tile.tx1 - tile.tx0;
            tile.height = tile.ty1 - tile.ty0;
            tile.components = [];
            tiles.push(tile);
        }
    }
    context.tiles = tiles;

    let componentsCount = siz.Csiz;
    for (let i = 0, ii = componentsCount; i < ii; i++) {
        let component = components[i];
        for (let j = 0, jj = tiles.length; j < jj; j++) {
            let tileComponent = {};
            let tile = tiles[j];
            tileComponent.tcx0 = Math.ceil(tile.tx0 / component.XRsiz);
            tileComponent.tcy0 = Math.ceil(tile.ty0 / component.YRsiz);
            tileComponent.tcx1 = Math.ceil(tile.tx1 / component.XRsiz);
            tileComponent.tcy1 = Math.ceil(tile.ty1 / component.YRsiz);
            tileComponent.width = tileComponent.tcx1 - tileComponent.tcx0;
            tileComponent.height = tileComponent.tcy1 - tileComponent.tcy0;
            tile.components[i] = tileComponent;
        }
    }
}

const getBlocksDimensions = (component, r) => {
    let codOrCoc = component.codingStyleParameters;
    let result = {};
    if (!codOrCoc.entropyCoderWithCustomPrecincts) {
        result.PPx = 15;
        result.PPy = 15;
    } else {
        result.PPx = codOrCoc.precinctsSizes[r].PPx;
        result.PPy = codOrCoc.precinctsSizes[r].PPy;
    }
    // calculate codeblock size as described in section B.7
    result.xcb_ = (r > 0) ? Math.min(codOrCoc.xcb, result.PPx - 1) : Math.min(codOrCoc.xcb, result.PPx);
    result.ycb_ = (r > 0) ? Math.min(codOrCoc.ycb, result.PPy - 1) : Math.min(codOrCoc.ycb, result.PPy);
    return result;
}
const buildPrecincts = (resolution, dimensions) => {
    // Section B.6 Division resolution to precincts
    let precinctWidth = 1 << dimensions.PPx;
    let precinctHeight = 1 << dimensions.PPy;
    let isZeroRes = resolution.resLevel === 0;
    let precinctWidthInSubband = 1 << (dimensions.PPx + (isZeroRes ? 0 : -1));
    let precinctHeightInSubband = 1 << (dimensions.PPy + (isZeroRes ? 0 : -1));
    let numprecinctswide = resolution.trx1 > resolution.trx0 ? (Math.ceil(resolution.trx1 / precinctWidth) - Math.floor(resolution.trx0 / precinctWidth)) : 0;
    let numprecinctshigh = resolution.try1 > resolution.try0 ? (Math.ceil(resolution.try1 / precinctHeight) - Math.floor(resolution.try0 / precinctHeight)) : 0;
    let numprecincts = numprecinctswide * numprecinctshigh;

    resolution.precinctParameters = {
        precinctWidth,
        precinctHeight,
        numprecinctswide,
        numprecinctshigh,
        numprecincts,
        precinctWidthInSubband,
        precinctHeightInSubband,
    }
}
const buildCodeblocks = (subband, dimensions) => {
    // Section B.7 Division sub-band into code-blocks
    let xcb_ = dimensions.xcb_;
    let ycb_ = dimensions.ycb_;
    let codeblockWidth = 1 << xcb_;
    let codeblockHeight = 1 << ycb_;
    let cbx0 = subband.tbx0 >> xcb_;
    let cby0 = subband.tby0 >> ycb_;
    let cbx1 = (subband.tbx1 + codeblockWidth - 1) >> xcb_;
    let cby1 = (subband.tby1 + codeblockHeight - 1) >> ycb_;
    let precinctParameters = subband.resolution.precinctParameters;
    let codeblocks = [];
    let precincts = [];
    let i, j, codeblock, precinctNumber;
    for (j = cby0; j < cby1; j++) {
        for (i = cbx0; i < cbx1; i++) {
            codeblock = {
                cbx: i,
                cby: j,
                tbx0: codeblockWidth * i,
                tby0: codeblockHeight * j,
                tbx1: codeblockWidth * (i + 1),
                tby1: codeblockHeight * (j + 1),
            }

            codeblock.tbx0_ = Math.max(subband.tbx0, codeblock.tbx0);
            codeblock.tby0_ = Math.max(subband.tby0, codeblock.tby0);
            codeblock.tbx1_ = Math.min(subband.tbx1, codeblock.tbx1);
            codeblock.tby1_ = Math.min(subband.tby1, codeblock.tby1);

            let pi = Math.floor((codeblock.tbx0_ - subband.tbx0) / precinctParameters.precinctWidthInSubband);
            let pj = Math.floor((codeblock.tby0_ - subband.tby0) / precinctParameters.precinctHeightInSubband);
            precinctNumber = pi + pj * precinctParameters.numprecinctswide;

            codeblock.precinctNumber = precinctNumber;
            codeblock.subbandType = subband.type;
            codeblock.Lblock = 3;

            if (codeblock.tbx1_ <= codeblock.tbx0_ || codeblock.tby1_ <= codeblock.tby0_) continue;
            codeblocks.push(codeblock);
            // building precinct for the sub-band
            let precinct = precincts[precinctNumber];
            if (precinct !== undefined) {
                if (i < precinct.cbxMin) precinct.cbxMin = i;
                else if (i > precinct.cbxMax) precinct.cbxMax = i;

                if (j < precinct.cbyMin) precinct.cbxMin = j;
                else if (j > precinct.cbyMax) precinct.cbyMax = j;
            } else {
                precincts[precinctNumber] = precinct = {
                    cbxMin: i,
                    cbyMin: j,
                    cbxMax: i,
                    cbyMax: j,
                };
            }
            codeblock.precinct = precinct;
        }
    }
    subband.codeblockParameters = {
        codeblockWidth: xcb_,
        codeblockHeight: ycb_,
        numcodeblockwide: cbx1 - cbx0 + 1,
        numcodeblockhigh: cby1 - cby0 + 1,
    };
    subband.codeblocks = codeblocks;
    subband.precincts = precincts;
}

const createPacket = (resolution, precinctNumber, layerNumber) => {
    let precinctCodeblocks = [];
    // Section B.10.8 Order of info in packet
    let subbands = resolution.subbands;
    // sub-bands already ordered in 'LL', 'HL', 'LH', and 'HH' sequence
    for (let i = 0, ii = subbands.length; i < ii; i++) {
        let subband = subbands[i];
        let codeblocks = subband.codeblocks;
        for (let j = 0, jj = codeblocks.length; j < jj; j++) {
            let codeblock = codeblocks[j];
            if (codeblock.precinctNumber !== precinctNumber) continue;
            precinctCodeblocks.push(codeblock);
        }
    }
    return { layerNumber, codeblocks: precinctCodeblocks }
}
class LayerResolutionComponentPositionIterator {
    constructor(context) {
        let siz = context.SIZ;
        let tileIndex = context.currentTile.index;
        let tile = context.tiles[tileIndex];
        let layersCount = tile.codingStyleDefaultParameters.layersCount;
        let componentsCount = siz.Csiz;
        let maxDecompositionLevelsCount = 0;
        for (let q = 0; q < componentsCount; q++) maxDecompositionLevelsCount = Math.max(
            maxDecompositionLevelsCount,
            tile.components[q].codingStyleParameters.decompositionLevelsCount
        );

        var l = 0, r = 0, i = 0, k = 0;

        this.nextPacket = function() {
            // Section B.12.1.1 Layer-resolution-component-position
            for (; l < layersCount; l++) {
                for (; r <= maxDecompositionLevelsCount; r++) {
                    for (; i < componentsCount; i++) {
                        let component = tile.components[i];
                        if (r > component.codingStyleParameters.decompositionLevelsCount) continue;

                        let resolution = component.resolutions[r];
                        let numprecincts = resolution.precinctParameters.numprecincts;
                        for (; k < numprecincts;) {
                            let packet = createPacket(resolution, k, l);
                            k++;
                            return packet;
                        }
                        k = 0;
                    }
                    i = 0;
                }
                r = 0;
            }
            throw new JpxError("Out of packets");
        };
    }
}
class ResolutionLayerComponentPositionIterator {
    constructor(context) {
        let siz = context.SIZ;
        let tileIndex = context.currentTile.index;
        let tile = context.tiles[tileIndex];
        let layersCount = tile.codingStyleDefaultParameters.layersCount;
        let componentsCount = siz.Csiz;
        let maxDecompositionLevelsCount = 0;
        for (let q = 0; q < componentsCount; q++) {
            maxDecompositionLevelsCount = Math.max(
                maxDecompositionLevelsCount,
                tile.components[q].codingStyleParameters.decompositionLevelsCount
            );
        }

        var r = 0, l = 0, i = 0, k = 0;

        this.nextPacket = function () {
            // Section B.12.1.2 Resolution-layer-component-position
            for (; r <= maxDecompositionLevelsCount; r++) {
                for (; l < layersCount; l++) {
                    for (; i < componentsCount; i++) {
                        let component = tile.components[i];
                        if (r > component.codingStyleParameters.decompositionLevelsCount) continue;

                        let resolution = component.resolutions[r];
                        let numprecincts = resolution.precinctParameters.numprecincts;
                        for (; k < numprecincts;) {
                            let packet = createPacket(resolution, k, l);
                            k++;
                            return packet;
                        }
                        k = 0;
                    }
                    i = 0;
                }
                l = 0;
            }
            throw new JpxError("Out of packets");
        };
    }
}
class ResolutionPositionComponentLayerIterator {
    constructor(context) {
        let siz = context.SIZ;
        let tileIndex = context.currentTile.index;
        let tile = context.tiles[tileIndex];
        let layersCount = tile.codingStyleDefaultParameters.layersCount;
        let componentsCount = siz.Csiz;
        var l, r, c, p;
        let maxDecompositionLevelsCount = 0;
        for (c = 0; c < componentsCount; c++) {
            const component = tile.components[c];
            maxDecompositionLevelsCount = Math.max(maxDecompositionLevelsCount, component.codingStyleParameters.decompositionLevelsCount);
        }
        let maxNumPrecinctsInLevel = new Int32Array(maxDecompositionLevelsCount + 1);
        for (r = 0; r <= maxDecompositionLevelsCount; ++r) {
            let maxNumPrecincts = 0;
            for (c = 0; c < componentsCount; ++c) {
                let resolutions = tile.components[c].resolutions;
                if (r < resolutions.length) {
                    maxNumPrecincts = Math.max(
                        maxNumPrecincts,
                        resolutions[r].precinctParameters.numprecincts
                    );
                }
            }
            maxNumPrecinctsInLevel[r] = maxNumPrecincts;
        }
        l = 0;
        r = 0;
        c = 0;
        p = 0;

        this.nextPacket = function JpxImage_nextPacket() {
            // Section B.12.1.3 Resolution-position-component-layer
            for (; r <= maxDecompositionLevelsCount; r++) {
                for (; p < maxNumPrecinctsInLevel[r]; p++) {
                    for (; c < componentsCount; c++) {
                        const component = tile.components[c];
                        if (r > component.codingStyleParameters.decompositionLevelsCount) continue;
                        let resolution = component.resolutions[r];
                        let numprecincts = resolution.precinctParameters.numprecincts;
                        if (p >= numprecincts) continue;
                        for (; l < layersCount;) {
                            let packet = createPacket(resolution, p, l);
                            l++;
                            return packet;
                        }
                        l = 0;
                    }
                    c = 0;
                }
                p = 0;
            }
            throw new JpxError("Out of packets");
        };
    }
}
class PositionComponentResolutionLayerIterator {
    constructor(context) {
        let siz = context.SIZ;
        let tileIndex = context.currentTile.index;
        let tile = context.tiles[tileIndex];
        let layersCount = tile.codingStyleDefaultParameters.layersCount;
        let componentsCount = siz.Csiz;
        let precinctsSizes = getPrecinctSizesInImageScale(tile);
        let precinctsIterationSizes = precinctsSizes;
        var l = 0, r = 0, c = 0, px = 0, py = 0;

        this.nextPacket = function () {
            // Section B.12.1.4 Position-component-resolution-layer
            for (; py < precinctsIterationSizes.maxNumHigh; py++) {
                for (; px < precinctsIterationSizes.maxNumWide; px++) {
                    for (; c < componentsCount; c++) {
                        let component = tile.components[c];
                        let decompositionLevelsCount = component.codingStyleParameters.decompositionLevelsCount;
                        for (; r <= decompositionLevelsCount; r++) {
                            let resolution = component.resolutions[r];
                            let sizeInImageScale = precinctsSizes.components[c].resolutions[r];
                            let k = getPrecinctIndexIfExist(px, py, sizeInImageScale, precinctsIterationSizes, resolution);
                            if (k === null) continue;
                            for (; l < layersCount;) {
                                let packet = createPacket(resolution, k, l);
                                l++;
                                return packet;
                            }
                            l = 0;
                        }
                        r = 0;
                    }
                    c = 0;
                }
                px = 0;
            }
            throw new JpxError("Out of packets");
        };
    }
}
class ComponentPositionResolutionLayerIterator {
    constructor(context) {
        let siz = context.SIZ;
        let tileIndex = context.currentTile.index;
        let tile = context.tiles[tileIndex];
        let layersCount = tile.codingStyleDefaultParameters.layersCount;
        let componentsCount = siz.Csiz;
        let precinctsSizes = getPrecinctSizesInImageScale(tile);
        var l = 0, r = 0, c = 0, px = 0, py = 0;

        this.nextPacket = function () {
            // Section B.12.1.5 Component-position-resolution-layer
            for (; c < componentsCount; ++c) {
                let component = tile.components[c];
                let precinctsIterationSizes = precinctsSizes.components[c];
                let decompositionLevelsCount = component.codingStyleParameters.decompositionLevelsCount;
                for (; py < precinctsIterationSizes.maxNumHigh; py++) {
                    for (; px < precinctsIterationSizes.maxNumWide; px++) {
                        for (; r <= decompositionLevelsCount; r++) {
                            let resolution = component.resolutions[r];
                            let sizeInImageScale = precinctsIterationSizes.resolutions[r];
                            let k = getPrecinctIndexIfExist(px, py, sizeInImageScale, precinctsIterationSizes, resolution);
                            if (k === null) continue;
                            for (; l < layersCount;) {
                                let packet = createPacket(resolution, k, l);
                                l++;
                                return packet;
                            }
                            l = 0;
                        }
                        r = 0;
                    }
                    px = 0;
                }
                py = 0;
            }
            throw new JpxError("Out of packets");
        };
    }
}

const getPrecinctIndexIfExist = (pxIndex, pyIndex, sizeInImageScale, precinctIterationSizes, resolution) => {
    let posX = pxIndex * precinctIterationSizes.minWidth;
    let posY = pyIndex * precinctIterationSizes.minHeight;
    if (posX % sizeInImageScale.width !== 0 || posY % sizeInImageScale.height !== 0) return null;
    let startPrecinctRowIndex = (posY / sizeInImageScale.width) *  resolution.precinctParameters.numprecinctswide;
    return posX / sizeInImageScale.height + startPrecinctRowIndex;
}

const getPrecinctSizesInImageScale = (tile) => {
    let componentsCount = tile.components.length;
    let minWidth = Number.MAX_VALUE;
    let minHeight = Number.MAX_VALUE;
    let maxNumWide = 0;
    let maxNumHigh = 0;
    let sizePerComponent = new Array(componentsCount);
    for (let c = 0; c < componentsCount; c++) {
        let component = tile.components[c];
        let decompositionLevelsCount = component.codingStyleParameters.decompositionLevelsCount;
        let sizePerResolution = new Array(decompositionLevelsCount + 1);
        let minWidthCurrentComponent = Number.MAX_VALUE;
        let minHeightCurrentComponent = Number.MAX_VALUE;
        let maxNumWideCurrentComponent = 0;
        let maxNumHighCurrentComponent = 0;
        let scale = 1;
        for (let r = decompositionLevelsCount; r >= 0; --r) {
            let resolution = component.resolutions[r];
            let widthCurrentResolution = scale * resolution.precinctParameters.precinctWidth;
            let heightCurrentResolution = scale * resolution.precinctParameters.precinctHeight;
            minWidthCurrentComponent = Math.min(minWidthCurrentComponent, widthCurrentResolution);
            minHeightCurrentComponent = Math.min(minHeightCurrentComponent, heightCurrentResolution);
            maxNumWideCurrentComponent = Math.max(maxNumWideCurrentComponent, resolution.precinctParameters.numprecinctswide);
            maxNumHighCurrentComponent = Math.max(maxNumHighCurrentComponent, resolution.precinctParameters.numprecinctshigh);
            sizePerResolution[r] = {
                width: widthCurrentResolution,
                height: heightCurrentResolution,
            }
            scale <<= 1;
        }
        minWidth = Math.min(minWidth, minWidthCurrentComponent);
        minHeight = Math.min(minHeight, minHeightCurrentComponent);
        maxNumWide = Math.max(maxNumWide, maxNumWideCurrentComponent);
        maxNumHigh = Math.max(maxNumHigh, maxNumHighCurrentComponent);
        sizePerComponent[c] = {
            resolutions: sizePerResolution,
            minWidth: minWidthCurrentComponent,
            minHeight: minHeightCurrentComponent,
            maxNumWide: maxNumWideCurrentComponent,
            maxNumHigh: maxNumHighCurrentComponent,
        }
    }
    return { components: sizePerComponent, minWidth, minHeight, maxNumWide, maxNumHigh }
}

const buildPackets = (context) => {
    var siz = context.SIZ;
    var tileIndex = context.currentTile.index;
    var tile = context.tiles[tileIndex];
    var componentsCount = siz.Csiz;
    // Creating resolutions and sub-bands for each component
    for (var c = 0; c < componentsCount; c++) {
        var component = tile.components[c];
        var decompositionLevelsCount = component.codingStyleParameters.decompositionLevelsCount;
        // Section B.5 Resolution levels and sub-bands
        var resolutions = [];
        var subbands = [];
        for (var r = 0; r <= decompositionLevelsCount; r++) {
            var blocksDimensions = getBlocksDimensions(component, r);
            var resolution = {};
            var scale = 1 << (decompositionLevelsCount - r);
            resolution.trx0 = Math.ceil(component.tcx0 / scale);
            resolution.try0 = Math.ceil(component.tcy0 / scale);
            resolution.trx1 = Math.ceil(component.tcx1 / scale);
            resolution.try1 = Math.ceil(component.tcy1 / scale);
            resolution.resLevel = r;
            buildPrecincts(resolution, blocksDimensions);
            resolutions.push(resolution);

            var subband;
            if (r === 0) {
                // one sub-band (LL) with last decomposition
                subband = {};
                subband.type = "LL";
                subband.tbx0 = Math.ceil(component.tcx0 / scale);
                subband.tby0 = Math.ceil(component.tcy0 / scale);
                subband.tbx1 = Math.ceil(component.tcx1 / scale);
                subband.tby1 = Math.ceil(component.tcy1 / scale);
                subband.resolution = resolution;
                buildCodeblocks(subband, blocksDimensions);
                subbands.push(subband);
                resolution.subbands = [subband];
            } else {
                var bscale = 1 << (decompositionLevelsCount - r + 1);
                var resolutionSubbands = [];
                // three sub-bands (HL, LH and HH) with rest of decompositions
                subband = {};
                subband.type = "HL";
                subband.tbx0 = Math.ceil(component.tcx0 / bscale - 0.5);
                subband.tby0 = Math.ceil(component.tcy0 / bscale);
                subband.tbx1 = Math.ceil(component.tcx1 / bscale - 0.5);
                subband.tby1 = Math.ceil(component.tcy1 / bscale);
                subband.resolution = resolution;
                buildCodeblocks(subband, blocksDimensions);
                subbands.push(subband);
                resolutionSubbands.push(subband);

                subband = {};
                subband.type = "LH";
                subband.tbx0 = Math.ceil(component.tcx0 / bscale);
                subband.tby0 = Math.ceil(component.tcy0 / bscale - 0.5);
                subband.tbx1 = Math.ceil(component.tcx1 / bscale);
                subband.tby1 = Math.ceil(component.tcy1 / bscale - 0.5);
                subband.resolution = resolution;
                buildCodeblocks(subband, blocksDimensions);
                subbands.push(subband);
                resolutionSubbands.push(subband);

                subband = {};
                subband.type = "HH";
                subband.tbx0 = Math.ceil(component.tcx0 / bscale - 0.5);
                subband.tby0 = Math.ceil(component.tcy0 / bscale - 0.5);
                subband.tbx1 = Math.ceil(component.tcx1 / bscale - 0.5);
                subband.tby1 = Math.ceil(component.tcy1 / bscale - 0.5);
                subband.resolution = resolution;
                buildCodeblocks(subband, blocksDimensions);
                subbands.push(subband);
                resolutionSubbands.push(subband);

                resolution.subbands = resolutionSubbands;
            }
        }
        component.resolutions = resolutions;
        component.subbands = subbands;
    }
    // Generate the packets sequence
    var progressionOrder = tile.codingStyleDefaultParameters.progressionOrder;
    switch (progressionOrder) {
        case 0:
            tile.packetsIterator = new LayerResolutionComponentPositionIterator(context);
            break;
        case 1:
            tile.packetsIterator = new ResolutionLayerComponentPositionIterator(context);
            break;
        case 2:
            tile.packetsIterator = new ResolutionPositionComponentLayerIterator(context);
            break;
        case 3:
            tile.packetsIterator = new PositionComponentResolutionLayerIterator(context);
            break;
        case 4:
            tile.packetsIterator = new ComponentPositionResolutionLayerIterator(context);
            break;
        default:
            throw new JpxError(`Unsupported progression order ${progressionOrder}`);
    }
}

const parseTilePackets = (context, data, offset, dataLength) => {
    let position = 0;
    let buffer, bufferSize = 0, skipNextBit = false;
    const readBits = (count) => {
        while (bufferSize < count) {
            let b = data[offset + position];
            position++;
            if (skipNextBit) {
                buffer = (buffer << 7) | b;
                bufferSize += 7;
                skipNextBit = false;
            } else {
                buffer = (buffer << 8) | b;
                bufferSize += 8;
            }
            if (b === 0xff) skipNextBit = true;
        }
        bufferSize -= count;
        return (buffer >>> bufferSize) & ((1 << count) - 1);
    }
    const skipMarkerIfEqual = (value) => {
        if (data[offset + position - 1] === 0xff && data[offset + position] === value) {
            skipBytes(1);
            return true;
        } else if (data[offset + position] === 0xff && data[offset + position + 1] === value) {
            skipBytes(2);
            return true;
        }
        return false;
    }
    const skipBytes = (count) => position += count;
    const alignToByte = () => {
        bufferSize = 0;
        if (skipNextBit) {
            position++;
            skipNextBit = false;
        }
    }
    const readCodingpasses = () => {
        if (readBits(1) === 0) return 1;
        if (readBits(1) === 0) return 2;
        let value = readBits(2);
        if (value < 3) return value + 3;
        value = readBits(5);
        if (value < 31) return value + 6;
        value = readBits(7);
        return value + 37;
    }
    let tileIndex = context.currentTile.index;
    let tile = context.tiles[tileIndex];
    let sopMarkerUsed = context.COD.sopMarkerUsed;
    let ephMarkerUsed = context.COD.ephMarkerUsed;
    let packetsIterator = tile.packetsIterator;
    while (position < dataLength) {
        alignToByte();
        if (sopMarkerUsed && skipMarkerIfEqual(0x91)) skipBytes(4);
        let packet = packetsIterator.nextPacket();
        if (!readBits(1)) continue;
        let layerNumber = packet.layerNumber;
        let queue = [], codeblock;
        for (let i = 0, ii = packet.codeblocks.length; i < ii; i++) {
            codeblock = packet.codeblocks[i];
            let precinct = codeblock.precinct;
            let codeblockColumn = codeblock.cbx - precinct.cbxMin;
            let codeblockRow = codeblock.cby - precinct.cbyMin;
            let codeblockIncluded = false;
            let firstTimeInclusion = false;
            let valueReady;
            if (codeblock.included !== undefined) codeblockIncluded = !!readBits(1);
            else {
                // reading inclusion tree
                precinct = codeblock.precinct;
                var inclusionTree, zeroBitPlanesTree;
                if (precinct.inclusionTree !== undefined) inclusionTree = precinct.inclusionTree;
                else {
                    // building inclusion and zero bit-planes trees
                    let width = precinct.cbxMax - precinct.cbxMin + 1;
                    let height = precinct.cbyMax - precinct.cbyMin + 1;
                    inclusionTree = new InclusionTree(width, height, layerNumber);
                    zeroBitPlanesTree = new TagTree(width, height);
                    precinct.inclusionTree = inclusionTree;
                    precinct.zeroBitPlanesTree = zeroBitPlanesTree;
                }

                if (inclusionTree.reset(codeblockColumn, codeblockRow, layerNumber)) {
                    while (true) {
                        if (readBits(1)) {
                            valueReady = !inclusionTree.nextLevel();
                            if (valueReady) {
                                codeblock.included = true;
                                codeblockIncluded = firstTimeInclusion = true;
                                break;
                            }
                        } else {
                            inclusionTree.incrementValue(layerNumber);
                            break;
                        }
                    }
                }
            }
            if (!codeblockIncluded) continue;
            if (firstTimeInclusion) {
                zeroBitPlanesTree = precinct.zeroBitPlanesTree;
                zeroBitPlanesTree.reset(codeblockColumn, codeblockRow);
                while (true) {
                    if (readBits(1)) {
                        valueReady = !zeroBitPlanesTree.nextLevel();
                        if (valueReady) break;
                    } else {
                        zeroBitPlanesTree.incrementValue();
                    }
                }
                codeblock.zeroBitPlanes = zeroBitPlanesTree.value;
            }
            let codingpasses = readCodingpasses();
            while (readBits(1)) codeblock.Lblock++;
            let codingpassesLog2 = log2(codingpasses);
            // rounding down log2
            let bits = (codingpasses < 1 << codingpassesLog2 ? codingpassesLog2 - 1 : codingpassesLog2) + codeblock.Lblock;
            let codedDataLength = readBits(bits);
            queue.push({ codeblock, codingpasses, dataLength: codedDataLength });
        }
        alignToByte();
        if (ephMarkerUsed) skipMarkerIfEqual(0x92);
        while (queue.length > 0) {
            let packetItem = queue.shift();
            codeblock = packetItem.codeblock;
            if (codeblock.data === undefined) codeblock.data = [];
            codeblock.data.push({ data, start: offset + position, end: offset + position + packetItem.dataLength, codingpasses: packetItem.codingpasses });
            position += packetItem.dataLength;
        }
    }
    return position;
}

const copyCoefficients = (coefficients, levelWidth, subband, delta, mb, reversible, segmentationSymbolUsed) => {
    let x0 = subband.tbx0;
    let y0 = subband.tby0;
    let width = subband.tbx1 - subband.tbx0;
    let codeblocks = subband.codeblocks;
    let right = subband.type.charAt(0) === "H" ? 1 : 0;
    let bottom = subband.type.charAt(1) === "H" ? levelWidth : 0;

    for (let i = 0, ii = codeblocks.length; i < ii; ++i) {
        let codeblock = codeblocks[i];
        let blockWidth = codeblock.tbx1_ - codeblock.tbx0_;
        let blockHeight = codeblock.tby1_ - codeblock.tby0_;
        if (blockWidth === 0 || blockHeight === 0) continue;
        if (codeblock.data === undefined) continue;

        let bitModel = new BitModel(blockWidth, blockHeight, codeblock.subbandType, codeblock.zeroBitPlanes, mb),
            currentCodingpassType = 2;

        // collect data
        let data = codeblock.data, totalLength = 0, codingpasses = 0;
        //var j, jj, dataItem;
        for (let j = 0, jj = data.length; j < jj; j++) {
            let dataItem = data[j];
            totalLength += dataItem.end - dataItem.start;
            codingpasses += dataItem.codingpasses;
        }
        let encodedData = new Uint8Array(totalLength);
        let position = 0;
        for (let j = 0, jj = data.length; j < jj; j++) {
            let dataItem = data[j];
            let chunk = dataItem.data.subarray(dataItem.start, dataItem.end);
            encodedData.set(chunk, position);
            position += chunk.length;
        }
        // decoding the item
        let decoder = new ArithmeticDecoder(encodedData, 0, totalLength);
        bitModel.setDecoder(decoder);

        for (let j = 0; j < codingpasses; j++) {
            switch (currentCodingpassType) {
                case 0:
                    bitModel.runSignificancePropagationPass();
                    break;
                case 1:
                    bitModel.runMagnitudeRefinementPass();
                    break;
                case 2:
                    bitModel.runCleanupPass();
                    if (segmentationSymbolUsed) {
                        bitModel.checkSegmentationSymbol();
                    }
                    break;
            }
            currentCodingpassType = (currentCodingpassType + 1) % 3;
        }

        let offset = codeblock.tbx0_ - x0 + (codeblock.tby0_ - y0) * width;
        let sign = bitModel.coefficentsSign;
        let magnitude = bitModel.coefficentsMagnitude;
        let bitsDecoded = bitModel.bitsDecoded;
        let magnitudeCorrection = reversible ? 0 : 0.5;
        position = 0;
        // Do the interleaving of Section F.3.3 here, so we do not need
        // to copy later. LL level is not interleaved, just copied.
        let interleave = subband.type !== "LL";
        for (let j = 0; j < blockHeight; j++) {
            let row = (offset / width) | 0; // row in the non-interleaved subband
            let levelOffset = 2 * row * (levelWidth - width) + right + bottom;
            for (let k = 0; k < blockWidth; k++) {
                let n = magnitude[position];
                if (n !== 0) {
                    n = (n + magnitudeCorrection) * delta;
                    if (sign[position] !== 0) n = -n;
                    let nb = bitsDecoded[position];
                    let pos = interleave ? levelOffset + (offset << 1) : offset;
                    if (reversible && nb >= mb) coefficients[pos] = n;
                    else coefficients[pos] = n * (1 << (mb - nb));
                }
                offset++;
                position++;
            }
            offset += width - blockWidth;
        }
    }
}

const transformTile = (context, tile, c) => {
    let component = tile.components[c];
    let codingStyleParameters = component.codingStyleParameters;
    let quantizationParameters = component.quantizationParameters;
    let decompositionLevelsCount = codingStyleParameters.decompositionLevelsCount;
    let spqcds = quantizationParameters.SPqcds;
    let scalarExpounded = quantizationParameters.scalarExpounded;
    let guardBits = quantizationParameters.guardBits;
    let segmentationSymbolUsed = codingStyleParameters.segmentationSymbolUsed;
    let precision = context.components[c].precision;
    let reversible = codingStyleParameters.reversibleTransformation;
    let transform = reversible ? new ReversibleTransform() : new IrreversibleTransform();

    let subbandCoefficients = [];
    let b = 0;
    for (let i = 0; i <= decompositionLevelsCount; i++) {
        let resolution = component.resolutions[i];
        let width = resolution.trx1 - resolution.trx0;
        let height = resolution.try1 - resolution.try0;
        // Allocate space for the whole sublevel.
        let coefficients = new Float32Array(width * height);

        for (let j = 0, jj = resolution.subbands.length; j < jj; j++) {
            let mu, epsilon;
            if (!scalarExpounded) {
                // formula E-5
                mu = spqcds[0].mu;
                epsilon = spqcds[0].epsilon + (i > 0 ? 1 - i : 0);
            } else {
                mu = spqcds[b].mu;
                epsilon = spqcds[b].epsilon;
                b++;
            }

            let subband = resolution.subbands[j];
            let gainLog2 = SubbandsGainLog2[subband.type];

            // calculate quantization coefficient (Section E.1.1.1)
            let delta = reversible ? 1 : (2 ** (precision + gainLog2 - epsilon) * (1 + mu / 2048));
            let mb = guardBits + epsilon - 1;

            copyCoefficients(coefficients, width, subband, delta, mb, reversible, segmentationSymbolUsed);
        }
        subbandCoefficients.push({ width, height, items: coefficients });
    }

    let result = transform.calculate(subbandCoefficients, component.tcx0, component.tcy0);
    return {
        left: component.tcx0,
        top: component.tcy0,
        width: result.width,
        height: result.height,
        items: result.items
    }
}

const transformComponents = (context) => {
    let siz = context.SIZ;
    let components = context.components;
    let componentsCount = siz.Csiz;
    let resultImages = [];
    for (let i = 0, ii = context.tiles.length; i < ii; i++) {
        let tile = context.tiles[i];
        let transformedTiles = [];
        for (let c = 0; c < componentsCount; c++) transformedTiles[c] = transformTile(context, tile, c);
        let tile0 = transformedTiles[0];
        let out = new Uint8ClampedArray(tile0.items.length * componentsCount);
        let result = {
            left: tile0.left,
            top: tile0.top,
            width: tile0.width,
            height: tile0.height,
            items: out
        }

        // Section G.2.2 Inverse multi component transform
        let shift, offset;
        let pos = 0, j, jj, y0, y1, y2;
        if (tile.codingStyleDefaultParameters.multipleComponentTransform) {
            let fourComponents = componentsCount === 4;
            let y0items = transformedTiles[0].items;
            let y1items = transformedTiles[1].items;
            let y2items = transformedTiles[2].items;
            let y3items = fourComponents ? transformedTiles[3].items : null;

            // HACK: The multiple component transform formulas below assume that
            // all components have the same precision. With this in mind, we
            // compute shift and offset only once.
            shift = components[0].precision - 8;
            offset = (128 << shift) + 0.5;

            let component0 = tile.components[0];
            let alpha01 = componentsCount - 3;
            jj = y0items.length;
            if (!component0.codingStyleParameters.reversibleTransformation) {
                // inverse irreversible multiple component transform
                for (j = 0; j < jj; j++, pos += alpha01) {
                    y0 = y0items[j] + offset;
                    y1 = y1items[j];
                    y2 = y2items[j];
                    out[pos++] = (y0 + 1.402 * y2) >> shift;
                    out[pos++] = (y0 - 0.34413 * y1 - 0.71414 * y2) >> shift;
                    out[pos++] = (y0 + 1.772 * y1) >> shift;
                }
            } else {
                // inverse reversible multiple component transform
                for (j = 0; j < jj; j++, pos += alpha01) {
                    y0 = y0items[j] + offset;
                    y1 = y1items[j];
                    y2 = y2items[j];
                    const g = y0 - ((y2 + y1) >> 2);

                    out[pos++] = (g + y2) >> shift;
                    out[pos++] = g >> shift;
                    out[pos++] = (g + y1) >> shift;
                }
            }
            if (fourComponents) {
                for (j = 0, pos = 3; j < jj; j++, pos += 4) out[pos] = (y3items[j] + offset) >> shift;
            }
        } else {
            // no multi-component transform
            for (let c = 0; c < componentsCount; c++) {
                let items = transformedTiles[c].items;
                shift = components[c].precision - 8;
                offset = (128 << shift) + 0.5;
                for (pos = c, j = 0, jj = items.length; j < jj; j++) {
                    out[pos] = (items[j] + offset) >> shift;
                    pos += componentsCount;
                }
            }
        }
        resultImages.push(result);
    }
    return resultImages;
}

const initializeTile = (context, tileIndex) => {
    let siz = context.SIZ;
    let componentsCount = siz.Csiz;
    let tile = context.tiles[tileIndex];
    for (let c = 0; c < componentsCount; c++) {
        let component = tile.components[c];
        component.quantizationParameters = (context.currentTile.QCC[c] !== undefined) ? context.currentTile.QCC[c] : context.currentTile.QCD;;
        component.codingStyleParameters = (context.currentTile.COC[c] !== undefined) ? context.currentTile.COC[c] : context.currentTile.COD;
    }
    tile.codingStyleDefaultParameters = context.currentTile.COD;
}

// Section B.10.2 Tag trees
class TagTree {
    constructor(width, height) {
        let levelsLength = log2(Math.max(width, height)) + 1;
        this.levels = [];
        for (let i = 0; i < levelsLength; i++) {
            this.levels.push({ width, height, items: [] });
            width = Math.ceil(width / 2);
            height = Math.ceil(height / 2);
        }
    }
    reset(i, j) {
        let currentLevel = 0, value = 0, level;
        while (currentLevel < this.levels.length) {
            level = this.levels[currentLevel];
            let index = i + j * level.width;
            if (level.items[index] !== undefined) {
                value = level.items[index];
                break;
            }
            level.index = index;
            i >>= 1;
            j >>= 1;
            currentLevel++;
        }
        currentLevel--;
        level = this.levels[currentLevel];
        level.items[level.index] = value;
        this.currentLevel = currentLevel;
        delete this.value;
    }
    incrementValue() {
        let level = this.levels[this.currentLevel];
        level.items[level.index]++;
    }
    nextLevel() {
        let currentLevel = this.currentLevel;
        let level = this.levels[currentLevel];
        let value = level.items[level.index];
        currentLevel--;
        if (currentLevel < 0) {
            this.value = value;
            return false;
        }

        this.currentLevel = currentLevel;
        level = this.levels[currentLevel];
        level.items[level.index] = value;
        return true;
    }
}

class InclusionTree {
    constructor(width, height, defaultValue) {
        let levelsLength = log2(Math.max(width, height)) + 1;
        this.levels = [];
        for (let i = 0; i < levelsLength; i++) {
            let items = new Uint8Array(width * height);
            for (let j = 0, jj = items.length; j < jj; j++) items[j] = defaultValue;

            this.levels.push({ width, height, items });

            width = Math.ceil(width / 2);
            height = Math.ceil(height / 2);
        }
    }
    reset(i, j, stopValue) {
        let currentLevel = 0;
        while (currentLevel < this.levels.length) {
            let level = this.levels[currentLevel];
            let index = i + j * level.width;
            level.index = index;
            let value = level.items[index];

            if (value === 0xff) break;
            if (value > stopValue) {
                this.currentLevel = currentLevel;
                // already know about this one, propagating the value to top levels
                this.propagateValues();
                return false;
            }

            i >>= 1;
            j >>= 1;
            currentLevel++;
        }
        this.currentLevel = currentLevel - 1;
        return true;
    }
    incrementValue(stopValue) {
        let level = this.levels[this.currentLevel];
        level.items[level.index] = stopValue + 1;
        this.propagateValues();
    }
    propagateValues() {
        let levelIndex = this.currentLevel;
        let level = this.levels[levelIndex];
        let currentValue = level.items[level.index];
        while (--levelIndex >= 0) {
            level = this.levels[levelIndex];
            level.items[level.index] = currentValue;
        }
    }
    nextLevel() {
        let currentLevel = this.currentLevel;
        let level = this.levels[currentLevel];
        let value = level.items[level.index];
        level.items[level.index] = 0xff;
        currentLevel--;
        if (currentLevel < 0) return false;

        this.currentLevel = currentLevel;
        level = this.levels[currentLevel];
        level.items[level.index] = value;
        return true;
    }
}

// Section D. Coefficient bit modeling
class BitModel {
    constructor(width, height, subband, zeroBitPlanes, mb) {
        this.width = width;
        this.height = height;

        let contextLabelTable;
        if (subband === "HH") contextLabelTable = HHContextLabel;
        else if (subband === "HL") contextLabelTable = HLContextLabel;
        else contextLabelTable = LLAndLHContextsLabel;
        this.contextLabelTable = contextLabelTable;

        let coefficientCount = width * height;

        // coefficients outside the encoding region treated as insignificant
        // add border state cells for significanceState
        this.neighborsSignificance = new Uint8Array(coefficientCount);
        this.coefficentsSign = new Uint8Array(coefficientCount);
        let coefficentsMagnitude;
        if (mb > 14) coefficentsMagnitude = new Uint32Array(coefficientCount);
        else if (mb > 6) coefficentsMagnitude = new Uint16Array(coefficientCount);
        else coefficentsMagnitude = new Uint8Array(coefficientCount);
        this.coefficentsMagnitude = coefficentsMagnitude;
        this.processingFlags = new Uint8Array(coefficientCount);

        let bitsDecoded = new Uint8Array(coefficientCount);
        if (zeroBitPlanes !== 0) {
            for (var i = 0; i < coefficientCount; i++) bitsDecoded[i] = zeroBitPlanes;
        }
        this.bitsDecoded = bitsDecoded;

        this.reset();
    }
    setDecoder(decoder) { this.decoder = decoder; }
    reset() {
        // We have 17 contexts that are accessed via context labels,
        // plus the uniform and runlength context.
        this.contexts = new Int8Array(19);

        // Contexts are packed into 1 byte:
        // highest 7 bits carry the index, lowest bit carries mps
        this.contexts[0] = (4 << 1) | 0;
        this.contexts[UNIFORM_CONTEXT] = (46 << 1) | 0;
        this.contexts[RUNLENGTH_CONTEXT] = (3 << 1) | 0;
    }
    setNeighborsSignificance(row, column, index) {
        let neighborsSignificance = this.neighborsSignificance;
        let width = this.width, height = this.height;
        let left = column > 0;
        let right = column + 1 < width;
        let i;

        if (row > 0) {
            i = index - width;
            if (left) neighborsSignificance[i - 1] += 0x10;
            if (right) neighborsSignificance[i + 1] += 0x10;
            neighborsSignificance[i] += 0x04;
        }

        if (row + 1 < height) {
            i = index + width;
            if (left) neighborsSignificance[i - 1] += 0x10;
            if (right) neighborsSignificance[i + 1] += 0x10;
            neighborsSignificance[i] += 0x04;
        }

        if (left) neighborsSignificance[index - 1] += 0x01;
        if (right) neighborsSignificance[index + 1] += 0x01;
        neighborsSignificance[index] |= 0x80;
    }
    runSignificancePropagationPass() {
        let decoder = this.decoder;
        let width = this.width, height = this.height;
        let coefficentsMagnitude = this.coefficentsMagnitude;
        let coefficentsSign = this.coefficentsSign;
        let neighborsSignificance = this.neighborsSignificance;
        let processingFlags = this.processingFlags;
        let contexts = this.contexts;
        let labels = this.contextLabelTable;
        let bitsDecoded = this.bitsDecoded;
        let processedInverseMask = ~1;
        let processedMask = 1;
        let firstMagnitudeBitMask = 2;

        for (let i0 = 0; i0 < height; i0 += 4) {
            for (let j = 0; j < width; j++) {
                let index = i0 * width + j;
                for (let i1 = 0; i1 < 4; i1++, index += width) {
                    let i = i0 + i1;
                    if (i >= height) break;
                    // clear processed flag first
                    processingFlags[index] &= processedInverseMask;

                    if (coefficentsMagnitude[index] || !neighborsSignificance[index]) continue;

                    let contextLabel = labels[neighborsSignificance[index]];
                    let decision = decoder.readBit(contexts, contextLabel);
                    if (decision) {
                        let sign = this.decodeSignBit(i, j, index);
                        coefficentsSign[index] = sign;
                        coefficentsMagnitude[index] = 1;
                        this.setNeighborsSignificance(i, j, index);
                        processingFlags[index] |= firstMagnitudeBitMask;
                    }
                    bitsDecoded[index]++;
                    processingFlags[index] |= processedMask;
                }
            }
        }
    }
    decodeSignBit(row, column, index) {
        let width = this.width, height = this.height;
        let coefficentsMagnitude = this.coefficentsMagnitude;
        let coefficentsSign = this.coefficentsSign;
        let contribution, sign0, sign1;
        let contextLabel, decoded;

        // calculate horizontal contribution
        let significance1 = column > 0 && coefficentsMagnitude[index - 1] !== 0;
        if (column + 1 < width && coefficentsMagnitude[index + 1] !== 0) {
            sign1 = coefficentsSign[index + 1];
            if (significance1) {
                sign0 = coefficentsSign[index - 1];
                contribution = 1 - sign1 - sign0;
            }
            else contribution = 1 - sign1 - sign1;
        } else if (significance1) {
            sign0 = coefficentsSign[index - 1];
            contribution = 1 - sign0 - sign0;
        }
        else contribution = 0;
        let horizontalContribution = 3 * contribution;

        // calculate vertical contribution and combine with the horizontal
        significance1 = row > 0 && coefficentsMagnitude[index - width] !== 0;
        if (row + 1 < height && coefficentsMagnitude[index + width] !== 0) {
            sign1 = coefficentsSign[index + width];
            if (significance1) {
                sign0 = coefficentsSign[index - width];
                contribution = 1 - sign1 - sign0 + horizontalContribution;
            }
            else contribution = 1 - sign1 - sign1 + horizontalContribution;
        } else if (significance1) {
            sign0 = coefficentsSign[index - width];
            contribution = 1 - sign0 - sign0 + horizontalContribution;
        }
        else contribution = horizontalContribution;

        if (contribution >= 0) {
            contextLabel = 9 + contribution;
            decoded = this.decoder.readBit(this.contexts, contextLabel);
        } else {
            contextLabel = 9 - contribution;
            decoded = this.decoder.readBit(this.contexts, contextLabel) ^ 1;
        }
        return decoded;
    }
    runMagnitudeRefinementPass() {
        let decoder = this.decoder;
        let width = this.width, height = this.height;
        let coefficentsMagnitude = this.coefficentsMagnitude;
        let neighborsSignificance = this.neighborsSignificance;
        let contexts = this.contexts;
        let bitsDecoded = this.bitsDecoded;
        let processingFlags = this.processingFlags;
        let processedMask = 1;
        let firstMagnitudeBitMask = 2;
        let length = width * height;
        let width4 = width * 4;

        for (let index0 = 0, indexNext; index0 < length; index0 = indexNext) {
            indexNext = Math.min(length, index0 + width4);
            for (let j = 0; j < width; j++) {
                for (let index = index0 + j; index < indexNext; index += width) {
                    // significant but not those that have just become
                    if (!coefficentsMagnitude[index] || (processingFlags[index] & processedMask) !== 0) continue;

                    let contextLabel = 16;
                    if ((processingFlags[index] & firstMagnitudeBitMask) !== 0) {
                        processingFlags[index] ^= firstMagnitudeBitMask;
                        // first refinement
                        let significance = neighborsSignificance[index] & 127;
                        contextLabel = significance === 0 ? 15 : 14;
                    }

                    let bit = decoder.readBit(contexts, contextLabel);
                    coefficentsMagnitude[index] = (coefficentsMagnitude[index] << 1) | bit;
                    bitsDecoded[index]++;
                    processingFlags[index] |= processedMask;
                }
            }
        }
    }
    runCleanupPass() {
        let decoder = this.decoder;
        let width = this.width, height = this.height;
        let neighborsSignificance = this.neighborsSignificance;
        let coefficentsMagnitude = this.coefficentsMagnitude;
        let coefficentsSign = this.coefficentsSign;
        let contexts = this.contexts;
        let labels = this.contextLabelTable;
        let bitsDecoded = this.bitsDecoded;
        let processingFlags = this.processingFlags;
        let processedMask = 1;
        let firstMagnitudeBitMask = 2;
        let oneRowDown = width;
        let twoRowsDown = width * 2;
        let threeRowsDown = width * 3;
        let iNext;
        for (let i0 = 0; i0 < height; i0 = iNext) {
            iNext = Math.min(i0 + 4, height);
            let indexBase = i0 * width;
            let checkAllEmpty = i0 + 3 < height;
            for (let j = 0; j < width; j++) {
                let index0 = indexBase + j;
                // using the property: labels[neighborsSignificance[index]] === 0
                // when neighborsSignificance[index] === 0
                let allEmpty = checkAllEmpty &&
                    processingFlags[index0] === 0 &&
                    processingFlags[index0 + oneRowDown] === 0 &&
                    processingFlags[index0 + twoRowsDown] === 0 &&
                    processingFlags[index0 + threeRowsDown] === 0 &&
                    neighborsSignificance[index0] === 0 &&
                    neighborsSignificance[index0 + oneRowDown] === 0 &&
                    neighborsSignificance[index0 + twoRowsDown] === 0 &&
                    neighborsSignificance[index0 + threeRowsDown] === 0;
                let i1 = 0, index = index0;
                let i = i0, sign;
                if (allEmpty) {
                    let hasSignificantCoefficent = decoder.readBit(contexts, RUNLENGTH_CONTEXT);
                    if (!hasSignificantCoefficent) {
                        bitsDecoded[index0]++;
                        bitsDecoded[index0 + oneRowDown]++;
                        bitsDecoded[index0 + twoRowsDown]++;
                        bitsDecoded[index0 + threeRowsDown]++;
                        continue; // next column
                    }
                    i1 = (decoder.readBit(contexts, UNIFORM_CONTEXT) << 1) | decoder.readBit(contexts, UNIFORM_CONTEXT);
                    if (i1 !== 0) {
                        i = i0 + i1;
                        index += i1 * width;
                    }

                    sign = this.decodeSignBit(i, j, index);
                    coefficentsSign[index] = sign;
                    coefficentsMagnitude[index] = 1;
                    this.setNeighborsSignificance(i, j, index);
                    processingFlags[index] |= firstMagnitudeBitMask;

                    index = index0;
                    for (let i2 = i0; i2 <= i; i2++, index += width) bitsDecoded[index]++;

                    i1++;
                }
                for (i = i0 + i1; i < iNext; i++, index += width) {
                    if (coefficentsMagnitude[index] || (processingFlags[index] & processedMask) !== 0) continue;

                    let contextLabel = labels[neighborsSignificance[index]];
                    let decision = decoder.readBit(contexts, contextLabel);
                    if (decision === 1) {
                        sign = this.decodeSignBit(i, j, index);
                        coefficentsSign[index] = sign;
                        coefficentsMagnitude[index] = 1;
                        this.setNeighborsSignificance(i, j, index);
                        processingFlags[index] |= firstMagnitudeBitMask;
                    }
                    bitsDecoded[index]++;
                }
            }
        }
    }
    checkSegmentationSymbol() {
        let decoder = this.decoder;
        let contexts = this.contexts;
        let symbol = (decoder.readBit(contexts, UNIFORM_CONTEXT) << 3) | (decoder.readBit(contexts, UNIFORM_CONTEXT) << 2) | (decoder.readBit(contexts, UNIFORM_CONTEXT) << 1) | decoder.readBit(contexts, UNIFORM_CONTEXT);
        if (symbol !== 0xa) throw new JpxError("Invalid segmentation symbol");
    }
}

// Section F, Discrete wavelet transformation
class Transform {
    constructor() { }
    calculate(subbands, u0, v0) {
        let ll = subbands[0];
        for (var i = 1, ii = subbands.length; i < ii; i++) ll = this.iterate(ll, subbands[i], u0, v0); 
        return ll;
    }
    extend(buffer, offset, size) {
        // Section F.3.7 extending... using max extension of 4
        let i1 = offset - 1, j1 = offset + 1;
        let i2 = offset + size - 2, j2 = offset + size;
        buffer[i1--] = buffer[j1++];
        buffer[j2++] = buffer[i2--];
        buffer[i1--] = buffer[j1++];
        buffer[j2++] = buffer[i2--];
        buffer[i1--] = buffer[j1++];
        buffer[j2++] = buffer[i2--];
        buffer[i1] = buffer[j1];
        buffer[j2] = buffer[i2];
    }
    iterate(ll, hl_lh_hh, u0, v0) {
        let llWidth = ll.width, llHeight = ll.height, llItems = ll.items;
        let width = hl_lh_hh.width;
        let height = hl_lh_hh.height;
        let items = hl_lh_hh.items;
        let i, j, k, l, u, v;

        // Interleave LL according to Section F.3.3
        for (k = 0, i = 0; i < llHeight; i++) {
            l = i * 2 * width;
            for (j = 0; j < llWidth; j++, k++, l += 2) items[l] = llItems[k];
        }
        // The LL band is not needed anymore.
        llItems = ll.items = null;

        let bufferPadding = 4;
        let rowBuffer = new Float32Array(width + 2 * bufferPadding);

        // Section F.3.4 HOR_SR
        if (width === 1) {
            // if width = 1, when u0 even keep items as is, when odd divide by 2
            if ((u0 & 1) !== 0) {
                for (v = 0, k = 0; v < height; v++, k += width) items[k] *= 0.5;
            }
        } else {
            for (v = 0, k = 0; v < height; v++, k += width) {
                rowBuffer.set(items.subarray(k, k + width), bufferPadding);
                this.extend(rowBuffer, bufferPadding, width);
                this.filter(rowBuffer, bufferPadding, width);
                items.set(rowBuffer.subarray(bufferPadding, bufferPadding + width), k);
            }
        }

        // Accesses to the items array can take long, because it may not fit into
        // CPU cache and has to be fetched from main memory. Since subsequent
        // accesses to the items array are not local when reading columns, we
        // have a cache miss every time. To reduce cache misses, get up to
        // 'numBuffers' items at a time and store them into the individual
        // buffers. The colBuffers should be small enough to fit into CPU cache.
        let numBuffers = 16;
        let colBuffers = [];
        for (i = 0; i < numBuffers; i++) colBuffers.push(new Float32Array(height + 2 * bufferPadding));
        let b, currentBuffer = 0;
        ll = bufferPadding + height;

        // Section F.3.5 VER_SR
        if (height === 1) {
            // if height = 1, when v0 even keep items as is, when odd divide by 2
            if ((v0 & 1) !== 0) {
                for (u = 0; u < width; u++) items[u] *= 0.5;
            }
        } else {
            for (u = 0; u < width; u++) {
                // if we ran out of buffers, copy several image columns at once
                if (currentBuffer === 0) {
                    numBuffers = Math.min(width - u, numBuffers);
                    for (k = u, l = bufferPadding; l < ll; k += width, l++) {
                        for (b = 0; b < numBuffers; b++) colBuffers[b][l] = items[k + b];
                    }
                    currentBuffer = numBuffers;
                }

                currentBuffer--;
                let buffer = colBuffers[currentBuffer];
                this.extend(buffer, bufferPadding, height);
                this.filter(buffer, bufferPadding, height);

                // If this is last buffer in this group of buffers, flush all buffers.
                if (currentBuffer === 0) {
                    k = u - numBuffers + 1;
                    for (l = bufferPadding; l < ll; k += width, l++) {
                        for (b = 0; b < numBuffers; b++) items[k + b] = colBuffers[b][l];
                    }
                }
            }
        }

        return { width, height, items }
    }
}

// Section 3.8.2 Irreversible 9-7 filter
class IrreversibleTransform extends Transform {
    constructor() { super(); }
    filter(x, offset, length) {
        let len = length >> 1;
        offset = offset | 0;
        let j, n, current, next;

        let alpha = -1.586134342059924;
        let beta = -0.052980118572961;
        let gamma = 0.882911075530934;
        let delta = 0.443506852043971;
        let K = 1.230174104914001;
        let K_ = 1 / K;

        // step 1 is combined with step 3
        // step 2
        j = offset - 3;
        for (n = len + 4; n--; j += 2) x[j] *= K_;

        // step 1 & 3
        j = offset - 2;
        current = delta * x[j - 1];
        for (n = len + 3; n--; j += 2) {
            next = delta * x[j + 1];
            x[j] = K * x[j] - current - next;
            if (n--) {
                j += 2;
                current = delta * x[j + 1];
                x[j] = K * x[j] - current - next;
            }
            else break;
        }

        // step 4
        j = offset - 1;
        current = gamma * x[j - 1];
        for (n = len + 2; n--; j += 2) {
            next = gamma * x[j + 1];
            x[j] -= current + next;
            if (n--) {
                j += 2;
                current = gamma * x[j + 1];
                x[j] -= current + next;
            }
            else break;
        }

        // step 5
        j = offset;
        current = beta * x[j - 1];
        for (n = len + 1; n--; j += 2) {
            next = beta * x[j + 1];
            x[j] -= current + next;
            if (n--) {
                j += 2;
                current = beta * x[j + 1];
                x[j] -= current + next;
            }
            else break;
        }

        // step 6
        if (len !== 0) {
            j = offset + 1;
            current = alpha * x[j - 1];
            for (n = len; n--; j += 2) {
                next = alpha * x[j + 1];
                x[j] -= current + next;
                if (n--) {
                    j += 2;
                    current = alpha * x[j + 1];
                    x[j] -= current + next;
                }
                else break;
            }
        }
    }
}

// Section 3.8.1 Reversible 5-3 filter
class ReversibleTransform extends Transform {
    constructor() { super(); }
    filter(x, offset, length) {
        let len = length >> 1;
        offset = offset | 0;
        let j, n;

        for (j = offset, n = len + 1; n--; j += 2) x[j] -= (x[j - 1] + x[j + 1] + 2) >> 2;
        for (j = offset + 1, n = len; n--; j += 2) x[j] += (x[j - 1] + x[j + 1]) >> 1;
    }
}