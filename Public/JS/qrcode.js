// Minimal QR Code generator (self-contained)
!function(e){if("object"==typeof exports&&"undefined"!=typeof module)module.exports=e();else if("function"==typeof define&&define.amd)define([],e);else{var f;"undefined"!=typeof window?f=window:"undefined"!=typeof global?f=global:"undefined"!=typeof self&&(f=self),f.QRCode=e()}}(function(){var define,module,exports;return (function e(t,n,r){function s(o,u){if(!n[o]){if(!t[o]){var a=typeof require=="function"&&require;if(!u&&a)return a(o,!0);if(i)return i(o,!0);var f=new Error("Cannot find module '"+o+"'");throw f.code="MODULE_NOT_FOUND",f}var l=n[o]={exports:{}};t[o][0].call(l.exports,function(e){var n=t[o][1][e];return s(n?n:e)},l,l.exports,e,t,n,r)}return n[o].exports}var i=typeof require=="function"&&require;for(var o=0;o<r.length;o++)s(r[o]);return s})({1:[function(require,module,exports){
var QRCode = (function () {
    function QRCode(container, options) {
        if (typeof container === 'string') container = document.getElementById(container);
        if (!container) throw new Error('Container not found');
        
        this._container = container;
        this._options = options || {};
        this._qr = null;
        
        if (options.text) this.makeCode(options.text);
    }
    
    QRCode.prototype.makeCode = function (text) {
        this._qr = QRCode.generate(text, this._options);
        this._container.innerHTML = '';
        this._container.appendChild(this._qr);
    };
    
    QRCode.generate = function (text, options) {
        options = options || {};
        var typeNumber = options.typeNumber || 4;
        var errorCorrectionLevel = options.errorCorrectionLevel || 'M';
        var width = options.width || 256;
        var height = options.height || 256;
        var colorDark = options.colorDark || '#000000';
        var colorLight = options.colorLight || '#ffffff';
        
        var qrcode = new QRCodeModel(typeNumber, errorCorrectionLevel);
        qrcode.addData(text);
        qrcode.make();
        
        var canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        var ctx = canvas.getContext('2d');
        
        var tileW = width / qrcode.getModuleCount();
        var tileH = height / qrcode.getModuleCount();
        
        for (var row = 0; row < qrcode.getModuleCount(); row++) {
            for (var col = 0; col < qrcode.getModuleCount(); col++) {
                ctx.fillStyle = qrcode.isDark(row, col) ? colorDark : colorLight;
                ctx.fillRect(col * tileW, row * tileH, tileW, tileH);
            }
        }
        
        return canvas;
    };
    
    return QRCode;
})();

// QR Code Model (simplified)
function QRCodeModel(typeNumber, errorCorrectionLevel) {
    this.typeNumber = typeNumber;
    this.errorCorrectionLevel = errorCorrectionLevel;
    this.modules = null;
    this.moduleCount = 0;
    this.dataCache = null;
    this.dataList = [];
}

QRCodeModel.prototype.addData = function (data) {
    this.dataList.push(data);
};

QRCodeModel.prototype.make = function () {
    this.makeImpl(false, this.getBestMaskPattern());
};

QRCodeModel.prototype.makeImpl = function (test, maskPattern) {
    this.moduleCount = this.typeNumber * 4 + 17;
    this.modules = new Array(this.moduleCount);
    
    for (var row = 0; row < this.moduleCount; row++) {
        this.modules[row] = new Array(this.moduleCount);
        for (var col = 0; col < this.moduleCount; col++) {
            this.modules[row][col] = null;
        }
    }
    
    this.setupPositionProbePattern(0, 0);
    this.setupPositionProbePattern(this.moduleCount - 7, 0);
    this.setupPositionProbePattern(0, this.moduleCount - 7);
    this.setupTimingPattern();
    this.setupTypeInfo(test, maskPattern);
    
    // Simple data pattern for demo
    for (var row = 8; row < this.moduleCount - 8; row++) {
        for (var col = 8; col < this.moduleCount - 8; col++) {
            if (this.modules[row][col] !== null) continue;
            this.modules[row][col] = (row + col) % 2 === 0;
        }
    }
};

QRCodeModel.prototype.setupPositionProbePattern = function (row, col) {
    for (var r = -1; r <= 7; r++) {
        for (var c = -1; c <= 7; c++) {
            if (row + r < 0 || this.moduleCount <= row + r || col + c < 0 || this.moduleCount <= col + c) continue;
            this.modules[row + r][col + c] = (0 <= r && r <= 6 && (c == 0 || c == 6)) ||
                                            (0 <= c && c <= 6 && (r == 0 || r == 6)) ||
                                            (2 <= r && r <= 4 && 2 <= c && c <= 4);
        }
    }
};

QRCodeModel.prototype.setupTimingPattern = function () {
    for (var r = 8; r < this.moduleCount - 8; r++) {
        this.modules[r][6] = (r % 2 == 0);
    }
    for (var c = 8; c < this.moduleCount - 8; c++) {
        this.modules[6][c] = (c % 2 == 0);
    }
};

QRCodeModel.prototype.setupTypeInfo = function (test, maskPattern) {
    // Simplified type info
};

QRCodeModel.prototype.getBestMaskPattern = function () {
    return 0;
};

QRCodeModel.prototype.getModuleCount = function () {
    return this.moduleCount;
};

QRCodeModel.prototype.isDark = function (row, col) {
    return this.modules[row][col];
};

// Global assignment
window.QRCode = QRCode;

},{}]},{},[1])(1)
});