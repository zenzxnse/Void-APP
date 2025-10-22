const colors = {
    brightRed: '#FF4136',
    grassGreen: '#2ECC40',
    skyBlue: '#0074D9',
    goldenYellow: '#FFDC00',
    vividPurple: '#B10DC9',
    hotPink: '#F012BE',
    deepOrange: '#FF851B',
    oceanBlue: '#39CCCC',
    lightGray: '#DDDDDD',
    darkGray: '#AAAAAA',
    default: '#2F3136'
};

function randomize(colors) {
    const colorKeys = Object.keys(colors);
    const randomKey = colorKeys[Math.floor(Math.random() * colorKeys.length)];
    return colors[randomKey];
}

const emojies = {
    modAction: '<a:instrymenti:1417222079303909426>',
    success: '<a:BAI_shieldcheck:1424413896596258859>',
    banHammer: ' <:4770blurplebanhammer:1233771724885987429>',
    loading: '<a:9754_Loading:1235703025557966960>',
    error: '<a:f_:1233761388208328715>',
    voidEye: '<a:VoidEye:1424152524247535687>',
    timeout: '<:pro_timeout:1429469150882828358>',
    lock: '<a:locked:1429472225475563592>',
    channelLock: '<:IconTextChannelLocked:1429472432443494470>',
    questionMark: '<:whitequestionmark:1429472914532733069>'
}

export { colors, randomize, emojies };
