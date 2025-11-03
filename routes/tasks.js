const Task = require('../models/task');
const User = require('../models/user');

module.exports = function (router) {

    function safeJSON(str, fallback) {
        try { return JSON.parse(str); }
        catch { return fallback; }
    }

    //  GET /api/tasks
    router.get('/tasks', async (req, res) => {
        try {
            const where  = safeJSON(req.query.where, {});
            const sort   = safeJSON(req.query.sort, {});
            const select = safeJSON(req.query.select, {});
            const skip   = parseInt(req.query.skip) || 0;
            const limit  = req.query.limit ? parseInt(req.query.limit) : 100; // default 100 tasks

            //count mode
            if (req.query.count === "true") {
                // No pagination → full count
                if (!req.query.skip && !req.query.limit) {
                    const fullCount = await Task.countDocuments(where);
                    return res.status(200).json({ message: "OK", data: fullCount });
                }

                // Pagination exists → count after pagination
                const results = await Task.find(where)
                    .sort(sort)
                    .collation({ locale: "en", strength: 1 })
                    .select(select)
                    .skip(skip)
                    .limit(limit);

                return res.status(200).json({ message: "OK", data: results.length });
            }

            //Normal uery mode
            const tasks = await Task.find(where)
                .sort(sort)
                .collation({ locale: "en", strength: 1 })
                .select(select)
                .skip(skip)
                .limit(limit);

            return res.status(200).json({ message: "OK", data: tasks });

        } catch (err) {
            return res.status(400).json({ message: "Invalid query", data: err.message });
        }
    });

    // POST /api/tasks
    router.post('/tasks', async (req, res) => {
        try {
            const { name, deadline, assignedUser, completed } = req.body;

            if (!name || !deadline)
            return res.status(400).json({ message: "Name and deadline required", data: {} });

            // Validate assignedUser if provided
            if (assignedUser) {
                let userDoc;
                try { userDoc = await User.findById(assignedUser); }
                catch {
                    return res.status(400).json({
                        message: "Invalid assignedUser ID",
                        data: {}
                    });
                }

                if (!userDoc) {
                    return res.status(400).json({
                        message: "assignedUser does not exist",
                        data: {}
                    });
                }

                // If assignedUserName exists in request, ensure match
                if (req.body.assignedUserName && req.body.assignedUserName !== userDoc.name) {
                    return res.status(400).json({
                        message: "assignedUserName does not match assignedUser",
                        data: {}
                    });
                }

                // Enforce correct name
                req.body.assignedUserName = userDoc.name;
            } else {
                req.body.assignedUserName = "unassigned";
            }

            const newTask = new Task(req.body);
            const saved = await newTask.save();

            //  Only add to pendingTasks if NOT completed
            if (assignedUser && !completed) {
            await User.findByIdAndUpdate(assignedUser, {
                $addToSet: { pendingTasks: saved._id }
            });
            }
            return res.status(201).json({ message: "Task created", data: saved });

        } catch (err) {
            return res.status(500).json({ message: "Server error creating task", data: err.message });
        }
    });

    //  GET /api/tasks/:id
    router.get('/tasks/:id', async (req, res) => {
        try {
            const select = safeJSON(req.query.select, {});
            const task = await Task.findById(req.params.id).select(select);

            if (!task)
                return res.status(404).json({ message: "Task not found", data: {} });

            return res.status(200).json({ message: "OK", data: task });

        } catch (err) {
            return res.status(400).json({ message: "Invalid task ID", data: {} });
        }
    });

    //  PUT /api/tasks/:id
    router.put('/tasks/:id', async (req, res) => {
        try {
            const { name, deadline, assignedUser, assignedUserName, completed } = req.body;

            if (!name || !deadline)
                return res.status(400).json({ message: "Name and deadline required", data: {} });

            const oldTask = await Task.findById(req.params.id);
            if (!oldTask)
                return res.status(404).json({ message: "Task not found", data: {} });

            // Validate assignedUser if provided
            let newUserDoc = null;
            if (assignedUser) {
                try { newUserDoc = await User.findById(assignedUser); }
                catch { return res.status(400).json({ message: "Invalid assignedUser ID", data: {} }); }

                if (!newUserDoc)
                    return res.status(400).json({ message: "assignedUser does not exist", data: {} });

                // If assignedUserName provided, must match DB user name
                if (assignedUserName && assignedUserName !== newUserDoc.name)
                    return res.status(400).json({ message: "assignedUserName does not match assignedUser", data: {} });

            } else {
                // If no assignedUser, ignore assignedUserName
                req.body.assignedUserName = "unassigned";
            }

            // Update task
            const updated = await Task.findByIdAndUpdate(req.params.id, req.body, { new: true });

            const oldUser = oldTask.assignedUser;
            const newUser = updated.assignedUser;

            // If completed → remove from pending lists
            if (updated.completed) {
                if (oldUser)
                    await User.findByIdAndUpdate(oldUser, { $pull: { pendingTasks: updated._id } });
                if (newUser && newUser !== oldUser)
                    await User.findByIdAndUpdate(newUser, { $pull: { pendingTasks: updated._id } });
            }

            // If reopened & assigned → add to pendingTasks
            if (oldTask.completed && !updated.completed && newUser) {
                await User.findByIdAndUpdate(newUser, { $addToSet: { pendingTasks: updated._id } });
            }

            // Assignment changed & not completed
            if (oldUser !== newUser && !updated.completed) {
                if (oldUser)
                    await User.findByIdAndUpdate(oldUser, { $pull: { pendingTasks: updated._id } });

                if (newUser)
                    await User.findByIdAndUpdate(newUser, { $addToSet: { pendingTasks: updated._id } });
            }

            return res.status(200).json({ message: "Task updated", data: updated });

        } catch (err) {
            console.log("TASK PUT ERROR", err);
            return res.status(400).json({ message: "Failed to update task", data: {} });
        }
    });


    //  DELETE /api/tasks/:id
    router.delete('/tasks/:id', async (req, res) => {
        try {
            const task = await Task.findById(req.params.id);
            if (!task)
                return res.status(404).json({ message: "Task not found", data: {} });

            // Remove task from user's pendingTasks
            if (task.assignedUser) {
                await User.findByIdAndUpdate(task.assignedUser, {
                    $pull: { pendingTasks: task._id }
                });
            }

            await Task.findByIdAndDelete(req.params.id);
            return res.status(204).send();

        } catch (err) {
            return res.status(400).json({ message: "Error deleting task", data: err.message });
        }
    });

    return router;
};
