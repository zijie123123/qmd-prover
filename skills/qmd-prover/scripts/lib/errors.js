export function asErrorLike(error) {
    return error && typeof error === 'object' ? error : { message: String(error) };
}
export function errorMessage(error) {
    return asErrorLike(error).message ?? String(error);
}
export function hasErrorCode(error, code) {
    return asErrorLike(error).code === code;
}
