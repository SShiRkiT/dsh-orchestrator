import io
p='lib/client.js'
s=io.open(p,encoding='utf-8').read()
old_control = """        const control = (slot, id, order) => ({
          name: slot,
          id,
          order,
          locale: NS,
          inject: (sessionId) => ({ setPlan: setPlanFor(sessionId) }),
        })

"""
assert old_control in s
s=s.replace(old_control,'')
start=s.index('        // The composer\'s own plan slot')
end=s.index('        const scopes = {')
new = """        // `conversation.input.plan` is a single-occupant slot and the shipped plan package claims
        // it: a second registration makes that package's activation throw, which fails the whole
        // web boot. The toggle takes a seat in the left list slot instead, next to the plan chip.
        ctx.slots.inject('conversation.input.left', () =>
          ctx.slots.register(
            { name: 'conversation.input.left', id: 'orchestrator-plan-toggle', order: 20, locale: NS },
            (props) => h(PlanToggle, Object.assign({}, props, { setPlan: setPlanFor(props.sessionId) })),
          ),
        )

"""
s=s[:start]+new+s[end:]
io.open(p,'w',encoding='utf-8',newline='\n').write(s)
print('patched client.js')
