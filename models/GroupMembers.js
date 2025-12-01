// ./models/GroupMembers.js
const mongoose = require('mongoose');

const GroupMembersSchema = new mongoose.Schema({
  sessionId: { type: String, required: true, index: true },
  groupId: { type: String, required: true, index: true },
  members: { type: [String], default: [] }, // array of jids (e.g. 234801234567@c.us)
  updatedAt: { type: Date, default: Date.now }
}, { collection: 'group_members' });

GroupMembersSchema.methods.hasMember = function(jid) {
  return this.members.indexOf(jid) !== -1;
};

module.exports = mongoose.models.GroupMembers || mongoose.model('GroupMembers', GroupMembersSchema);
