
/**
 * Flattens nested objects into dot-notation (e.g., {a: {b: 1}} -> "a.b": 1)
 */
export function flattenVariables(obj, prefix = '', target = {}) {
    for (const key in obj) {
        if (Object.prototype.hasOwnProperty.call(obj, key)) {
            const val = obj[key];
            const newKey = prefix ? `${prefix}.${key}` : key;
            if (typeof val === 'object' && val !== null && !Array.isArray(val)) {
                flattenVariables(val, newKey, target);
            } else {
                target[newKey] = val;
            }
        }
    }
    return target;
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
export function isPlainObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * @param {Record<string, unknown>} root
 * @param {string[]} pathParts
 * @returns {unknown}
 */
export function getValueByPath(root, pathParts) {
    /** @type {unknown} */
    let current = root;
    for (const part of pathParts) {
        if (!isPlainObject(current)) {
            return undefined;
        }

        if (!Object.prototype.hasOwnProperty.call(current, part)) {
            return undefined;
        }

        current = current[part];
    }
    return current;
}
