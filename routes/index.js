/*
 * Connect all of your endpoints together here.
 */
module.exports = function (app, router) {
    // Home route
    app.use('/api', require('./home.js')(router));

    // Users routes
    app.use('/api', require('./users.js')(router));

    // Tasks routes
    app.use('/api', require('./tasks.js')(router));
};
