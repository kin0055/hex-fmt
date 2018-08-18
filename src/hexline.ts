import * as vscode from 'vscode';

// Hex file types
var TYPES = {
    //DATA: 0x00,
    //EOF: 0x01,
    //EXTSEGADDRESS: 0x02,
    //STARTSEGADDRESS: 0x03,
    //EXTLINADDRESS: 0x04,
    //STARTLINADDRESS: 0x05,
    //for motorola type
    MOT_MARK:0x00,
    MOT_DATA_2ADDR:0x01,
    MOT_DATA_3ADDR:0x02,
    MOT_DATA_4ADDR:0x03,
    MOT_SUM_LOG:0x05,
    MOT_EXE_LOG_4ADDR:0x07,
    MOT_EXE_LOG_3ADDR:0x08,
    MOT_EXE_LOG_2ADDR:0x09
}


//| type(hex1) | count(hex 1) | address | data | checksum(从count累加到checksum，总和为0xFF) | 
// Header length = type(hex1) + count(hex 1) + address (2)
var HEADERLENGTH = 4

export class HexLine {
    startCode: string;
    nbData: number;
    address: number;
    hexType: number;
    datastart: number;
    data: number[];
    checksum: number;

    private _correctHdr : boolean;
    private _addOffset: number;
    private _byteSum: number;

    constructor(hexString: string, offset?: number) {
        // Initialize variables
        this._correctHdr = false;
        this._byteSum = 0;

        if(offset) {
            this._addOffset = offset;
        } else {
            this._addOffset = 0;
        }

        this.checksum = NaN;

        // Check if the header is correct
        if(hexString.length > HEADERLENGTH) {
            this.startCode = hexString.charAt(0);//S
            this.hexType = parseInt(hexString.charAt(1));//type
            this.nbData = this.parseAndUpdateChk(hexString, 0);//count(hex 1)

            //different address length by type
            if((this.hexType == TYPES.MOT_MARK) || (this.hexType == TYPES.MOT_DATA_2ADDR) || (this.hexType == TYPES.MOT_EXE_LOG_2ADDR)){
                this.address = 256 * this.parseAndUpdateChk(hexString, 1);
                this.address += this.parseAndUpdateChk(hexString, 2);
                this.datastart = 3;
            }else if((this.hexType == TYPES.MOT_DATA_3ADDR) || (this.hexType == TYPES.MOT_EXE_LOG_3ADDR)){
                this.address = 65536 * this.parseAndUpdateChk(hexString, 1);
                this.address += (256 * this.parseAndUpdateChk(hexString, 2));
                this.address += this.parseAndUpdateChk(hexString, 3);
                this.datastart = 4;
            }else if((this.hexType == TYPES.MOT_DATA_4ADDR) || (this.hexType == TYPES.MOT_EXE_LOG_4ADDR)){
                this.address = 16777216 * this.parseAndUpdateChk(hexString, 1);
                this.address += (65536 * this.parseAndUpdateChk(hexString, 2));
                this.address += (256 * this.parseAndUpdateChk(hexString, 3));
                this.address += this.parseAndUpdateChk(hexString, 4);
                this.datastart = 5;
            }


            this._correctHdr = (this.startCode === 'S' &&
                this.nbData != NaN &&
                this.address != NaN &&
                this.hexType != NaN &&
                this.hexType != 0x06 &&
                this.hexType != 0x04 && this.hexType <= TYPES.MOT_EXE_LOG_2ADDR);
        }

        // Get the data
        this.data = [];
        if (this._correctHdr) {
            // Check how many bytes are present (data + chk)
            let nbBytes = Math.trunc((hexString.length - (this.datastart * 2) - (2 * 2)) / 2);
            let nb = Math.min(nbBytes, (this.nbData - this.datastart));

            // Try to get he right number of bytes
            for(let i = 0; i < nb; i++) {
                this.data.push(this.parseAndUpdateChk(hexString, this.datastart + i));
            }
        }

        // Get the checksum if possible
        if(this._correctHdr && (hexString.length >= (4 + 2*this.nbData))) {
            this.checksum = parseInt(hexString.substr(2 + 2*this.nbData, 2), 16);//last 2 byte
        }
    }

    private parseAndUpdateChk(hexString: string, byteId: number) {
        let res = parseInt(hexString.substr(2 + 2*byteId, 2), 16);
        this._byteSum += res;
        return res;
    }

    public isData(): boolean {
        return this._correctHdr && (this.hexType === TYPES.MOT_DATA_2ADDR || this.hexType === TYPES.MOT_DATA_3ADDR || this.hexType === TYPES.MOT_DATA_4ADDR);
    }

    public isExtendedAddress(): boolean {
        return this._correctHdr && (this.hexType === TYPES.MOT_EXE_LOG_4ADDR || this.hexType === TYPES.MOT_EXE_LOG_3ADDR || this.hexType === TYPES.MOT_EXE_LOG_2ADDR);
    }

    public size(): number {

        if(this.isData()){
            return (this.nbData - this.datastart);
        }
        
        return 0;
    }

    public charToAddress(character: number): number {
        if(this.isData()) {
            let relative = (character - ((this.datastart * 2) + 2)) / 2;
            if(relative >= 0)
            {
                relative = Math.trunc(relative)
                if (relative < (this.nbData - this.datastart)) {
                    return relative + this.address + this._addOffset;//?
                }
            }
        }

        return -1;
    }

    public extAddress(): number {
        if (this.address != NaN) {

            return this.address;
        }

        return -1;
    }

    public addressToChar(address: number , baseaddr: number) : number {
        if(this.isData()) {
            let lowRange = this.address + baseaddr;//
            let highRange = lowRange + (this.nbData - this.datastart);

            if(lowRange <= address && address <= highRange) {
                return ((address - lowRange) * 2) + (this.datastart * 2) + 2;
            }
        }
        return -1;
    }

    public computedChk() : number {
        return 255 - (this._byteSum % 256);// + 1
    }

    public isBroken() : boolean {
        if (this._correctHdr && ((this.nbData - this.datastart) == this.data.length))
        {
            return this.computedChk() != this.checksum;
        }
        return true
    }

    public repair() : boolean {
        // We can only repair lines that have at least a correct header
        if(this._correctHdr)
        {
            // First check that there is enough data
            if(this.data.length < (this.nbData - this.datastart)) {
                // Not enough, add zeroes
                let toAdd = ((this.nbData - this.datastart) - this.data.length);
                for(let i = 0; i < toAdd; i++)
                {
                    this.data.push(0);
                }
            } else if(this.data.length > (this.nbData - this.datastart)) {
                // Too much data, cut it
                this.data = this.data.slice(0, (this.nbData - this.datastart)-1);
            }

            // Compute checksum
            this.checksum = this.computedChk();

            return true;
        }

        return false;
    }

    private appendByte(str: string, byte: number) : string {
        return str.concat(("00" + byte.toString(16)).substr(-2));
    }

    private appendtype(str: string, byte: number) : string {
        return str.concat(("00" + byte.toString(16)).substr(-1));
    }

    public toString() : string {
        let res = 'S';

        // Add header
        res = this.appendtype(res, this.hexType);
        res = this.appendByte(res, this.nbData);

        // Add address
        if((this.hexType == TYPES.MOT_MARK) || (this.hexType == TYPES.MOT_DATA_2ADDR) || (this.hexType == TYPES.MOT_EXE_LOG_2ADDR)){
            res = this.appendByte(res, Math.trunc(this.address / 256));
            res = this.appendByte(res, (this.address % 256));
        }else if((this.hexType == TYPES.MOT_DATA_3ADDR) || (this.hexType == TYPES.MOT_EXE_LOG_3ADDR)){
            res = this.appendByte(res, Math.trunc(this.address / 65536));
            res = this.appendByte(res, Math.trunc(this.address / 256));
            res = this.appendByte(res, (this.address % 256));
        }else if((this.hexType == TYPES.MOT_DATA_4ADDR) || (this.hexType == TYPES.MOT_EXE_LOG_4ADDR)){
            res = this.appendByte(res, Math.trunc(this.address / 16777216));
            res = this.appendByte(res, Math.trunc(this.address / 65536));
            res = this.appendByte(res, Math.trunc(this.address / 256));
            res = this.appendByte(res, (this.address % 256));
        }
        
        // Add Data
        for(let i = 0; i < this.data.length; i++) {
            res = this.appendByte(res, this.data[i]);
        }

        // Add checksum
        res = this.appendByte(res, this.checksum);

        return res.toUpperCase();
    }
}