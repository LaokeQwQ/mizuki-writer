const MAX_SOURCE_LENGTH = 2 * 1024 * 1024;
const MAX_DEPTH = 100;

class LiteralParser {
    constructor(source) {
        if (typeof source !== 'string' || source.length > MAX_SOURCE_LENGTH) {
            throw new Error('数据文件过大或格式无效');
        }
        this.source = source;
        this.index = 0;
        this.depth = 0;
    }

    skipWhitespace() {
        while (this.index < this.source.length) {
            const char = this.source[this.index];
            if (/\s/.test(char)) {
                this.index++;
                continue;
            }
            if (char === '/' && this.source[this.index + 1] === '/') {
                this.index += 2;
                while (this.index < this.source.length && this.source[this.index] !== '\n') this.index++;
                continue;
            }
            if (char === '/' && this.source[this.index + 1] === '*') {
                const end = this.source.indexOf('*/', this.index + 2);
                if (end === -1) throw new Error('注释格式无效');
                this.index = end + 2;
                continue;
            }
            break;
        }
    }

    parseValue() {
        this.skipWhitespace();
        const char = this.source[this.index];
        if (char === '[') return this.parseArray();
        if (char === '{') return this.parseObject();
        if (char === '\'' || char === '"' || char === '`') return this.parseString();
        if (char === '-' || /\d/.test(char)) return this.parseNumber();

        const identifier = this.parseIdentifier();
        if (identifier === 'true') return true;
        if (identifier === 'false') return false;
        if (identifier === 'null') return null;
        if (identifier === 'undefined') return undefined;
        throw new Error(`不支持的数据值: ${identifier}`);
    }

    parseArray() {
        this.enter();
        this.index++;
        const result = [];
        this.skipWhitespace();
        while (this.index < this.source.length && this.source[this.index] !== ']') {
            result.push(this.parseValue());
            this.skipWhitespace();
            if (this.source[this.index] === ',') {
                this.index++;
                this.skipWhitespace();
                continue;
            }
            if (this.source[this.index] !== ']') throw new Error('数组缺少逗号');
        }
        if (this.source[this.index] !== ']') throw new Error('数组缺少结束括号');
        this.index++;
        this.leave();
        return result;
    }

    parseObject() {
        this.enter();
        this.index++;
        const result = Object.create(null);
        this.skipWhitespace();
        while (this.index < this.source.length && this.source[this.index] !== '}') {
            const key = this.parseObjectKey();
            this.skipWhitespace();
            if (this.source[this.index] !== ':') throw new Error('对象属性缺少冒号');
            this.index++;
            result[key] = this.parseValue();
            this.skipWhitespace();
            if (this.source[this.index] === ',') {
                this.index++;
                this.skipWhitespace();
                continue;
            }
            if (this.source[this.index] !== '}') throw new Error('对象缺少逗号');
        }
        if (this.source[this.index] !== '}') throw new Error('对象缺少结束括号');
        this.index++;
        this.leave();
        return result;
    }

    parseObjectKey() {
        this.skipWhitespace();
        const char = this.source[this.index];
        if (char === '\'' || char === '"' || char === '`') return this.parseString();
        return this.parseIdentifier();
    }

    parseString() {
        const quote = this.source[this.index++];
        let result = '';
        while (this.index < this.source.length) {
            const char = this.source[this.index++];
            if (char === quote) return result;
            if (char === '$' && quote === '`' && this.source[this.index] === '{') {
                throw new Error('不支持模板字符串插值');
            }
            if (char !== '\\') {
                result += char;
                continue;
            }

            if (this.index >= this.source.length) throw new Error('字符串转义无效');
            const escaped = this.source[this.index++];
            const escapes = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', '0': '\0' };
            if (escapes[escaped] !== undefined) {
                result += escapes[escaped];
            } else if (escaped === 'x') {
                result += String.fromCharCode(parseInt(this.readExact(2), 16));
            } else if (escaped === 'u') {
                result += String.fromCharCode(parseInt(this.readExact(4), 16));
            } else {
                result += escaped;
            }
        }
        throw new Error('字符串缺少结束引号');
    }

    readExact(length) {
        const value = this.source.slice(this.index, this.index + length);
        if (value.length !== length || !/^[0-9a-fA-F]+$/.test(value)) throw new Error('字符串转义无效');
        this.index += length;
        return value;
    }

    parseNumber() {
        const match = this.source.slice(this.index).match(/^-?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/);
        if (!match) throw new Error('数字格式无效');
        this.index += match[0].length;
        const value = Number(match[0]);
        if (!Number.isFinite(value)) throw new Error('数字超出范围');
        return value;
    }

    parseIdentifier() {
        const match = this.source.slice(this.index).match(/^[A-Za-z_$][\w$]*/);
        if (!match) throw new Error('标识符格式无效');
        this.index += match[0].length;
        return match[0];
    }

    enter() {
        this.depth++;
        if (this.depth > MAX_DEPTH) throw new Error('数据嵌套层级过深');
    }

    leave() {
        this.depth--;
    }
}

export function parseArrayLiteral(source) {
    const parser = new LiteralParser(source);
    const value = parser.parseValue();
    parser.skipWhitespace();
    if (parser.index !== source.length || !Array.isArray(value)) {
        throw new Error('导出的数据必须是数组字面量');
    }
    return value;
}
