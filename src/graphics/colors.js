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
    darkGray: '#AAAAAA'
};

function randomize(colors) {
    const colorKeys = Object.keys(colors);
    const randomKey = colorKeys[Math.floor(Math.random() * colorKeys.length)];
    return colors[randomKey];
}

export { colors, randomize };