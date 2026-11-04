// Reading, changing and writing a Launch debug runtime script, without running it
module.exports = {
    ...require('./parse'),
    ...require('./print'),
    ...require('./entries'),
    ...require('./checks')
};
