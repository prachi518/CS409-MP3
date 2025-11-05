const User = require('../models/user');
const Task = require('../models/task');

module.exports = function (router) {

    //  Safe JSON parser for query params
    function safeJSON(str, fallback) {
        try { return JSON.parse(str); }
        catch { return fallback; }
    }

    // GET /api/users
    router.get('/users', async (req, res) => {
        try {
            const where  = safeJSON(req.query.where, {});
            const sort   = safeJSON(req.query.sort, {});
            const select = safeJSON(req.query.select, {});
            const skip   = parseInt(req.query.skip) || 0;
            const limit  = req.query.limit ? parseInt(req.query.limit) : 0;

            //count mode
            if (req.query.count === "true") {
                // No pagination → return total count
                if (!req.query.skip && !req.query.limit) {
                    const fullCount = await User.countDocuments(where);
                    return res.status(200).json({ message: "OK", data: fullCount });
                }

                // Pagination exists → count after pagination
                const results = await User.find(where)
                    .sort(sort)
                    .collation({ locale: "en", strength: 1 })
                    .select(select)
                    .skip(skip)
                    .limit(limit ?? 0);

                return res.status(200).json({ message: "OK", data: results.length });
            }

            //Normal query mode
            const users = await User.find(where)
                .sort(sort)
                .collation({ locale: "en", strength: 1 })
                .select(select)
                .skip(skip)
                .limit(limit ?? 0);

            return res.status(200).json({ message: "OK", data: users });

        } catch (err) {
            return res.status(400).json({ message: "Invalid query", data: err.message });
        }
    });

    //  POST /api/users
    router.post('/users', async (req, res) => {
        try {
            const { name, email } = req.body;

            if (!name || !email)
                return res.status(400).json({ message: "Name and email required", data: {} });

            if (email.indexOf('@') === -1)
                return res.status(400).json({ message: "Please provide a valid email", data: {} });

            const user = new User(req.body);
            const saved = await user.save();

            return res.status(201).json({
                message: "User created",
                data: saved
            });

        } catch (err) {
            if (err.code === 11000) {
                return res.status(400).json({ message: "Email already exists", data: {} });
            }
            return res.status(500).json({ message: "Server error creating user", data: err.message });
        }
    });

    //  GET /api/users/:id
    router.get('/users/:id', async (req, res) => {
        try {
            const select = safeJSON(req.query.select, {});

            const user = await User.findById(req.params.id).select(select);

            if (!user)
                return res.status(404).json({ message: "User not found", data: {} });

            return res.status(200).json({ message: "OK", data: user });

        } catch (err) {
            return res.status(400).json({ message: "Invalid user ID. User IDs are 24 character long.", data: {} });
        }
    });

    //  PUT /api/users/:id
    router.put('/users/:id', async (req, res) => {
        try {
            const { name, email, pendingTasks = [] } = req.body;

            //Prevent client from modifying creation date, basically ignores even if you try to change
            if ("dateCreated" in req.body) delete req.body.dateCreated;

            if (!name || !email)
                return res.status(400).json({ message: "Name and email required", data: {} });

            if (email.indexOf('@') === -1)
                return res.status(400).json({ message: "Please provide a valid email", data: {} });

            const user = await User.findById(req.params.id);
            if (!user)
                return res.status(404).json({ message: "User not found", data: {} });

            //Email must be unique
            const existing = await User.findOne({ email });
            if (existing && existing._id.toString() !== req.params.id) {
                return res.status(400).json({ message: "Email already exists", data: {} });
            }

            //Validate & sync pending tasks
            if (Array.isArray(pendingTasks)) {
                for (let taskId of pendingTasks) {
                    const task = await Task.findById(taskId);

                    if (!task)
                        return res.status(400).json({ message: `Task ${taskId} not found`, data: {} });

                    //Cannot touch completed tasks
                    if (task.completed)
                        return res.status(400).json({ message: `Task ${taskId} is completed. Cannot modify`, data: {} });

                    // Reassign logic
                    if (task.assignedUser && task.assignedUser.toString() !== req.params.id) {
                        // move task from previous user → this user
                        await User.findByIdAndUpdate(task.assignedUser, {
                            $pull: { pendingTasks: task._id }
                        });
                    }

                    // Assign task to this user
                    await Task.findByIdAndUpdate(taskId, {
                        assignedUser: req.params.id,
                        assignedUserName: name
                    });
                }

                //Remove tasks no longer in pending list
                const oldPending = user.pendingTasks.map(String);
                const newPending = pendingTasks.map(String);

                for (let oldId of oldPending) {
                    if (!newPending.includes(oldId)) {
                        await Task.findByIdAndUpdate(oldId, {
                            assignedUser: "",
                            assignedUserName: "unassigned"
                        });
                    }
                }
            }

            //Now updating the user
            const updatedUser = await User.findByIdAndUpdate(
                req.params.id,
                { name, email, pendingTasks },
                { new: true }
            );

            //Cascade name change to tasks
            await Task.updateMany(
                { assignedUser: req.params.id },
                { assignedUserName: name }
            );

            return res.status(200).json({ message: "User updated", data: updatedUser });

        } catch (err) {
            return res.status(400).json({ message: "Failed to update user", data: err.message });
        }
    });


    //  DELETE /api/users/:id
    router.delete('/users/:id', async (req, res) => {
        try {
            const user = await User.findById(req.params.id);
            if (!user)
                return res.status(404).json({ message: "User not found", data: {} });

            // Unassign all pending tasks
            await Task.updateMany(
                { assignedUser: req.params.id },
                { assignedUser: "", assignedUserName: "unassigned" }
            );

            await User.findByIdAndDelete(req.params.id);

            return res.status(204).send(); // no content

        } catch (err) {
            return res.status(400).json({ message: "Error deleting user", data: err.message });
        }
    });

    return router;
};
