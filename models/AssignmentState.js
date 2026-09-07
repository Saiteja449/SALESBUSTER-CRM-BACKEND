import mongoose from "mongoose";

const assignmentStateSchema = new mongoose.Schema({
  key: {
    type: String,
    unique: true,
    default: "leadAssignment",
  },
  lastAssignedIndex: {
    type: Number,
    default: 0,
  },
});

const AssignmentState = mongoose.model(
  "AssignmentState",
  assignmentStateSchema,
);
export default AssignmentState;
