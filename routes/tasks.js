const Task = require('../models/task');
const User = require('../models/user');

module.exports = function (router) {

    function safeJSON(str, fallback) {
        try { return JSON.parse(str); }
        catch { return fallback; }
    }

    // GET /api/tasks
    router.get('/tasks', async (req, res) => {
        try {
            const where  = safeJSON(req.query.where, {});
            const sort   = safeJSON(req.query.sort, {});
            const select = safeJSON(req.query.select, {});
            const skip   = parseInt(req.query.skip) || 0;
            const limit  = req.query.limit ? parseInt(req.query.limit) : 100; // default 100 tasks

            //count mode
            if (req.query.count === "true") {
                // no pagination → full count
                if (!req.query.skip && !req.query.limit) {
                    const fullCount = await Task.countDocuments(where);
                    return res.status(200).json({ message: "OK", data: fullCount });
                }

                // pagination exists → count after pagination
                const results = await Task.find(where)
                    .sort(sort)
                    .collation({ locale: "en", strength: 1 })
                    .select(select)
                    .skip(skip)
                    .limit(limit);

                return res.status(200).json({ message: "OK", data: results.length });
            }

            //normal query mode
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
            const { name, deadline, assignedUser, assignedUserName, completed } = req.body;

            if (!name || !deadline)
                return res.status(400).json({ message: "Name and deadline required", data: {} });

            //This stops creation of already-completed assigned task, however this was commented out while filling the db
            if (completed && assignedUser)
                return res.status(400).json({message: "Cannot assign a completed task",data: {}});

            let userDoc = null;

            if (assignedUser) {
                try { userDoc = await User.findById(assignedUser); }
                catch { return res.status(400).json({ message: "Invalid assignedUser ID, User IDs are 24 character long.", data: {} }); }

                if (!userDoc)
                    return res.status(400).json({ message: "assignedUser does not exist", data: {} });

                if (assignedUserName && assignedUserName !== userDoc.name)
                    return res.status(400).json({ message: "assignedUserName does not match assignedUser", data: {} });

                req.body.assignedUserName = userDoc.name;
            } else {
                // name without user → invalid
                if (assignedUserName && assignedUserName !== "" && assignedUserName !== "unassigned")
                    return res.status(400).json({ message: "assignedUserName provided without assignedUser", data: {} });

                req.body.assignedUserName = "unassigned";
            }

            // allowing completed=true during seeding — just don't add to pendingTasks
            const saved = await new Task(req.body).save();

            if (assignedUser && !completed)
                await User.findByIdAndUpdate(assignedUser, { $addToSet: { pendingTasks: saved._id } });

            return res.status(201).json({ message: "Task created", data: saved });

        } catch (err) {
            return res.status(500).json({ message: "Server error creating task", data: err.message });
        }
    });


    // GET /api/tasks/:id
    router.get('/tasks/:id', async (req, res) => {
        try {
            const select = safeJSON(req.query.select, {});
            const task = await Task.findById(req.params.id).select(select);

            if (!task)
                return res.status(404).json({ message: "Task not found", data: {} });

            return res.status(200).json({ message: "OK", data: task });

        } catch (err) {
            return res.status(400).json({ message: "Invalid task ID. Task IDs are 24 character long.", data: {} });
        }
    });

    // PUT /api/tasks/:id
    router.put('/tasks/:id', async (req, res) => {
        try {
            const { name, description, deadline, assignedUser, assignedUserName, completed } = req.body;

            //Prevent client from modifying creation date, basically ignores even if he try to change
            if ("dateCreated" in req.body) delete req.body.dateCreated;
            if ("_id" in req.body) delete req.body._id;

            // Fields required in PUT for Task
            const requiredFields = [
                "name",
                "description",
                "deadline",
                "completed",
                "assignedUser"
            ];

            // check missing fields
            const missing = requiredFields.filter(f => !(f in req.body));
            if (missing.length) {
                return res.status(400).json({
                    message: `${missing.join(', ')} field(s) are required`,
                    data: {}
                });
            }

            // earlier requirement, then it changed :(
            // if (!name || !deadline)
            //     return res.status(400).json({ message: "Name and deadline required", data: {} });
            
            if (!name.trim() || !deadline.trim())
                return res.status(400).json({ message: "Name and deadline cannot be empty", data: {} });


            const oldTask = await Task.findById(req.params.id);
            if (!oldTask)
                return res.status(404).json({ message: "Task not found", data: {} });

            //Completed tasks cannot be modified
            if (oldTask.completed)
                return res.status(400).json({ message: "Cannot update a completed task", data: {} });

            //Validate assignedUser
            let newUserDoc = null;
            if (assignedUser) {
                try { newUserDoc = await User.findById(assignedUser); }
                catch { return res.status(400).json({ message: "Invalid assignedUser ID, User IDs are 24 character long.", data: {} }); }

                if (!newUserDoc)
                    return res.status(400).json({ message: "assignedUser does not exist", data: {} });

                if (assignedUserName && assignedUserName !== newUserDoc.name)
                    return res.status(400).json({ message: "assignedUserName does not match assignedUser", data: {} });

                req.body.assignedUserName = newUserDoc.name;
            } else {
                //assignedUserName provided without assignedUser
                if (assignedUserName && assignedUserName !== "" && assignedUserName !== "unassigned")
                    return res.status(400).json({
                        message: "assignedUserName provided without assignedUser",
                        data: {}
                    });

                req.body.assignedUserName = "unassigned";
            }

            //Normal update for still-active tasks
            const updated = await Task.findByIdAndUpdate(req.params.id, req.body, { new: true });
            const oldUser = oldTask.assignedUser;
            const newUser = updated.assignedUser;

            // assuming you can’t mark a task completed while assigning or reassigning it, don't want conflict here.
            // if task was active and is now being marked completed
            if (!oldTask.completed && updated.completed === true) {

                // Remove from pendingTasks if it had a user
                if (oldUser) {
                await User.findByIdAndUpdate(oldUser, { $pull: { pendingTasks: updated._id } });
                }
                return res.status(200).json({
                    message: "Task marked completed",
                    data: updated
                });
            }

            // Remove from old user pendingTasks if reassigned
            if (oldUser && oldUser.toString() !== newUser?.toString())
                await User.findByIdAndUpdate(oldUser, { $pull: { pendingTasks: updated._id } });

            // Add to new user's pendingTasks if not completed
            if (newUser && !updated.completed)
                await User.findByIdAndUpdate(newUser, { $addToSet: { pendingTasks: updated._id } });

            return res.status(200).json({ message: "Task updated", data: updated });

        } catch (err) {
            return res.status(500).json({ message: "Internal server error while updating task", data: err.message });
        }
    });

    //  DELETE /api/tasks/:id
    router.delete('/tasks/:id', async (req, res) => {
        try {
            let task;
            try {
            task = await Task.findById(req.params.id);
            } catch {
                return res.status(400).json({ message: "Invalid Task ID, Task IDs are 24 character long.", data: {} });
            }

            if (!task)
                return res.status(404).json({ message: "Task not found", data: {} });

            // Remove task from user's pendingTasks
            if (task.assignedUser) {
                await User.findByIdAndUpdate(task.assignedUser, {
                    $pull: { pendingTasks: task._id }
                });
            }

            await Task.findByIdAndDelete(req.params.id);
            return res.status(204).send(); // no content

        } catch (err) {
            return res.status(500).json({ message: "Internal server error while deleting task", data: err.message });
        }
    });

    return router;
};
